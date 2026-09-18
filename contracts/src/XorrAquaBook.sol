// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AquaApp } from "aqua/src/AquaApp.sol";
import { IAqua } from "aqua/src/interfaces/IAqua.sol";
import { XorrDelegation } from "./XorrDelegation.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title XorrAquaBook
 * @notice A self-custodial market-making book, run by a bot, inside limits the user controls.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Aqua's thesis is "earn yield on your tokens without depositing them into another contract."
 * XorrDelegation's thesis is "a bot trades your capital without you giving up custody."
 * They are the same idea on opposite sides of the book, so they compose exactly.
 *
 * A user here does two things, once:
 *   1. approves Aqua (their tokens NEVER move to us, or to Aqua, or into a pool), and
 *   2. grants the bot a XorrDelegation policy — capped per day, time-boxed, revocable in one tap.
 *
 * The bot then `ship()`s a USDC/asset book on their behalf and manages it. Takers swap against
 * the maker's VIRTUAL balance; the real tokens sit in the maker's wallet until the moment a fill
 * pulls them. The maker earns the spread.
 *
 * WHAT MAKES IT SAFE
 * ──────────────────
 * The bot is an operator, not an owner:
 *   - it can only ship/dock for a maker whose delegation names it as delegate,
 *   - it cannot change the maker, so it can never point a book at its own wallet,
 *   - a revoked or expired policy stops it shipping or re-shipping immediately,
 *   - `dock()` is ALWAYS available to the maker, with no bot cooperation, so a user can withdraw
 *     from the book even if our servers are gone.
 *
 * PRICING
 * ───────
 * Constant-product with a fee, plus a bounded oracle band. Tokenised equities trade 24/7 on-chain
 * while the underlying prints 24/5, so an unbounded x*y=k book is free money for an arbitrageur
 * overnight. `maxDeviationBps` refuses to quote further than a set distance from the reference
 * price — the single most important line in this file for a stock book.
 */
contract XorrAquaBook is AquaApp {
    /// @notice A book. Hashed to produce the Aqua strategy id, so its terms are immutable.
    struct Strategy {
        address maker;
        address token0;
        address token1;
        /// @dev Fee in basis points taken from the input amount.
        uint256 feeBps;
        /// @dev Max distance from `referencePrice` this book will quote, in bps. 0 = unbounded.
        uint256 maxDeviationBps;
        /**
         * @dev Reference price in RAW units: (token1 raw per token0 raw) x 1e18.
         *
         * Raw rather than human units so the check is decimal-agnostic and needs no decimals()
         * call. For WETH(18)/USDC(6) at 4000 USDC per WETH:
         *     4000e6 / 1e18 * 1e18 = 4e9
         * Use `rawReferencePrice()` to convert from a human price.
         */
        uint256 referencePrice;
        bytes32 salt;
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    /// @notice The permission contract that decides whether the bot may act for a maker.
    XorrDelegation public immutable DELEGATION;

    event BookShipped(address indexed maker, bytes32 indexed strategyHash, uint256 amount0, uint256 amount1);
    event BookDocked(address indexed maker, bytes32 indexed strategyHash);
    event Swapped(
        address indexed maker,
        bytes32 indexed strategyHash,
        address indexed taker,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut
    );

    error NotAuthorisedOperator(address caller, address maker);
    error MakerMismatch();
    error InsufficientOutputAmount(uint256 got, uint256 min);
    error EmptyBook();
    error PriceOutsideBand(uint256 quoted, uint256 referencePrice, uint256 maxDeviationBps);
    error IdenticalTokens();
    /// @notice A delegated fill named someone other than the owner whose capital is paying for it.
    error RecipientNotActiveOwner(address recipient, address activeOwner);

    constructor(IAqua aqua_, XorrDelegation delegation_) AquaApp(aqua_) {
        DELEGATION = delegation_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maker / operator
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice The exact arguments a maker passes to `Aqua.ship()` to open this book.
     *
     * Aqua records a strategy against `msg.sender`, so THE MAKER SHIPS THEIR OWN BOOK — an app
     * cannot do it for them, by design. That is a feature, not a limitation: it means no operator,
     * including us, can open a position in a user's name.
     *
     * The bot's job is to compute the terms; the user signs them. Exactly the same shape as
     * granting the delegation, and for the same reason.
     */
    function shipArgs(Strategy calldata strategy, uint256 amount0, uint256 amount1)
        external
        view
        returns (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts)
    {
        if (strategy.token0 == strategy.token1) revert IdenticalTokens();
        app = address(this);
        encoded = abi.encode(strategy);

        tokens = new address[](2);
        tokens[0] = strategy.token0;
        tokens[1] = strategy.token1;

        amounts = new uint256[](2);
        amounts[0] = amount0;
        amounts[1] = amount1;
    }

    /// @notice The token list a maker passes to `Aqua.dock()` to close this book and exit.
    function dockArgs(Strategy calldata strategy)
        external
        view
        returns (address app, bytes32 strategyHash, address[] memory tokens)
    {
        app = address(this);
        strategyHash = keccak256(abi.encode(strategy));
        tokens = new address[](2);
        tokens[0] = strategy.token0;
        tokens[1] = strategy.token1;
    }

    /// @dev The bot may act for a maker only while that maker's policy names it and is live.
    function _authorise(address maker) internal view {
        if (msg.sender == maker) return;
        (address delegate,, uint64 expiresAt, bool revoked) = DELEGATION.policyOf(maker);
        bool ok = delegate == msg.sender && !revoked && block.timestamp < expiresAt;
        if (!ok) revert NotAuthorisedOperator(msg.sender, maker);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Taker
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Swap against a maker's book.
     * @dev Aqua's settlement shape: we `pull` the output to the taker first, then require the
     *      taker to have `push`ed the input. `_safeCheckAquaPush` enforces that and reverts the
     *      whole transaction otherwise, so the optimistic transfer is safe.
     */
    function swapExactIn(
        Strategy calldata strategy,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external returns (uint256 amountOut) {
        // Reached through the delegation, this is the owner's capital: the output is theirs too.
        if (msg.sender == address(DELEGATION)) _requireActiveOwner(to);
        (address tokenIn,,,) = _sides(strategy, keccak256(abi.encode(strategy)), zeroForOne);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        return _swap(strategy, zeroForOne, amountIn, amountOutMin, to, true);
    }

    /**
     * @dev A fill paid for by a delegated owner pays out to that owner and nobody else.
     *
     * `principal` — and `to`, on the taker path — came from calldata the delegate wrote, so a leaked
     * delegate key could spend an owner's cap here and name itself as the recipient. The delegation
     * records whose trade is executing for exactly the length of the venue call; anything else is
     * refused before a token moves. PLAN.md 1.4.
     */
    function _requireActiveOwner(address recipient) internal view {
        address active = DELEGATION.activeOwner();
        if (recipient != active) revert RecipientNotActiveOwner(recipient, active);
    }

    /// @dev The single settlement path. `payer` has already funded this contract with `amountIn`.
    function _swap(
        Strategy calldata strategy,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        bool
    )
        internal
        nonReentrantStrategy(strategy.maker, keccak256(abi.encode(strategy)))
        returns (uint256 amountOut)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));
        (address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut) =
            _sides(strategy, strategyHash, zeroForOne);

        amountOut = _quote(strategy, balanceIn, balanceOut, amountIn, zeroForOne);
        if (amountOut < amountOutMin) revert InsufficientOutputAmount(amountOut, amountOutMin);

        AQUA.pull(strategy.maker, strategyHash, tokenOut, amountOut, to);

        IERC20(tokenIn).approve(address(AQUA), amountIn);
        AQUA.push(strategy.maker, address(this), strategyHash, tokenIn, amountIn);

        _safeCheckAquaPush(strategy.maker, strategyHash, tokenIn, balanceIn + amountIn);

        emit Swapped(strategy.maker, strategyHash, to, tokenIn, amountIn, tokenOut, amountOut);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pricing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice What a taker would receive. Pure view — safe to call from a UI on every keystroke.
    function quoteExactIn(Strategy calldata strategy, bool zeroForOne, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));
        (,, uint256 balanceIn, uint256 balanceOut) = _sides(strategy, strategyHash, zeroForOne);
        return _quote(strategy, balanceIn, balanceOut, amountIn, zeroForOne);
    }

    function _quote(
        Strategy calldata strategy,
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amountIn,
        bool zeroForOne
    ) internal pure returns (uint256 amountOut) {
        if (balanceIn == 0 || balanceOut == 0) revert EmptyBook();

        uint256 amountInAfterFee = amountIn - (amountIn * strategy.feeBps) / BPS;
        // Constant product: out = (bOut * inAfterFee) / (bIn + inAfterFee)
        amountOut = (balanceOut * amountInAfterFee) / (balanceIn + amountInAfterFee);

        if (strategy.maxDeviationBps != 0 && strategy.referencePrice != 0) {
            _requireWithinBand(strategy, amountIn, amountOut, zeroForOne);
        }
    }

    /**
     * @dev The band check. Without it, a 24/7 book on a 24/5 asset is a standing gift to whoever
     *      is awake when the underlying gaps. `referencePrice` is token1 per token0 at 1e18.
     */
    function _requireWithinBand(
        Strategy calldata strategy,
        uint256 amountIn,
        uint256 amountOut,
        bool zeroForOne
    ) internal pure {
        // Executed price, always expressed as token1 per token0 so it compares to the reference.
        uint256 executed = zeroForOne
            ? (amountOut * WAD) / amountIn // paying token0, receiving token1
            : (amountIn * WAD) / amountOut; // paying token1, receiving token0

        uint256 ref = strategy.referencePrice;
        uint256 diff = executed > ref ? executed - ref : ref - executed;
        if ((diff * BPS) / ref > strategy.maxDeviationBps) {
            revert PriceOutsideBand(executed, ref, strategy.maxDeviationBps);
        }
    }

    function _sides(Strategy calldata strategy, bytes32 strategyHash, bool zeroForOne)
        internal
        view
        returns (address tokenIn, address tokenOut, uint256 balanceIn, uint256 balanceOut)
    {
        (uint256 balance0, uint256 balance1) =
            AQUA.safeBalances(strategy.maker, address(this), strategyHash, strategy.token0, strategy.token1);

        return zeroForOne
            ? (strategy.token0, strategy.token1, balance0, balance1)
            : (strategy.token1, strategy.token0, balance1, balance0);
    }

    /**
     * @notice The maker's live virtual balances — what the app shows as "your book".
     * @dev Uses rawBalances, not safeBalances: Aqua's safe variant REVERTS once a strategy is
     *      docked, and a UI needs to be able to render a closed book as zeros rather than error.
     */
    function bookBalances(Strategy calldata strategy)
        external
        view
        returns (uint256 balance0, uint256 balance1)
    {
        bytes32 strategyHash = keccak256(abi.encode(strategy));
        (uint248 b0,) = AQUA.rawBalances(strategy.maker, address(this), strategyHash, strategy.token0);
        (uint248 b1,) = AQUA.rawBalances(strategy.maker, address(this), strategyHash, strategy.token1);
        return (uint256(b0), uint256(b1));
    }

    /// @notice Whether this book is currently open. False once the maker has docked.
    function isOpen(Strategy calldata strategy) external view returns (bool) {
        bytes32 strategyHash = keccak256(abi.encode(strategy));
        (, uint8 count) = AQUA.rawBalances(strategy.maker, address(this), strategyHash, strategy.token0);
        return count == 2;
    }

    function hashOf(Strategy calldata strategy) external pure returns (bytes32) {
        return keccak256(abi.encode(strategy));
    }

    /**
     * @notice Convert a human price into the raw-unit form `Strategy.referencePrice` expects.
     * @param humanPrice token1 per token0, scaled by 1e18 (4000 USDC/WETH -> 4000e18).
     * @param decimals0 decimals of token0.
     * @param decimals1 decimals of token1.
     */
    function rawReferencePrice(uint256 humanPrice, uint8 decimals0, uint8 decimals1)
        external
        pure
        returns (uint256)
    {
        return (humanPrice * (10 ** decimals1)) / (10 ** decimals0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Where the two protocols actually compose
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice The bot takes against a book using its principal's delegated capital.
     *
     * This is the join between Aqua and XorrDelegation, and it is the taker side because that is
     * the side an operator can legitimately act on:
     *   - the MAKER self-custodially provides liquidity through Aqua (they signed their own ship),
     *   - the TAKER's bot trades inside a cap the taker signed and can revoke.
     *
     * Neither party has handed custody to anyone, and the bot is bounded on both counts.
     *
     * The bot does NOT call this directly. It calls `XorrDelegation.spend()` with the calldata
     * from `delegatedFillArgs`, so the daily cap, the expiry, the revocation flag AND the venue
     * allowlist are all enforced by the contract the user actually signed. An earlier version
     * pulled the principal's tokens here after only re-reading the policy fields, which meant the
     * cap the user set was not applied on this path at all — the limit existed and did nothing.
     */
    function fillForDelegation(
        Strategy calldata strategy,
        address principal,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut) {
        if (msg.sender != address(DELEGATION)) revert NotAuthorisedOperator(msg.sender, principal);
        _requireActiveOwner(principal);

        // The delegation holds the pulled tokens and has approved this app for exactly amountIn.
        // Output goes straight to the principal; neither contract keeps a balance.
        (address tokenIn,,,) = _sides(strategy, keccak256(abi.encode(strategy)), zeroForOne);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        return _swap(strategy, zeroForOne, amountIn, amountOutMin, principal, false);
    }

    /**
     * @notice The exact arguments the bot passes to `XorrDelegation.spend()` for this fill.
     *
     * Same shape as `shipArgs`/`dockArgs`: this contract computes the terms, and the call that
     * moves money is made by whoever holds the authority to make it.
     */
    function delegatedFillArgs(
        Strategy calldata strategy,
        address principal,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin
    ) external view returns (address token, address venue, uint256 amount, bytes memory data) {
        (address tokenIn,,,) = _sides(strategy, keccak256(abi.encode(strategy)), zeroForOne);
        return (
            tokenIn,
            address(this),
            amountIn,
            abi.encodeCall(
                this.fillForDelegation, (strategy, principal, zeroForOne, amountIn, amountOutMin)
            )
        );
    }
}
