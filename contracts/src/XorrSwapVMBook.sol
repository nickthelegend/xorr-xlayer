// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISwapVM } from "swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "swap-vm/src/libs/TakerTraits.sol";
import { IAqua } from "aqua/src/interfaces/IAqua.sol";
import { XorrDelegation } from "./XorrDelegation.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title XorrSwapVMBook
 * @notice A xorr market-maker book expressed as a 1inch SwapVM program, and the delegated path
 *         that lets the bot take against it inside the user's on-chain limits.
 *
 * @dev Why SwapVM and not just Solidity.
 *
 * `XorrAquaBook` prices in Solidity: the maker's terms live in a struct and the curve is code we
 * wrote. That works, but the terms are then only as expressive as the struct, and changing them
 * means shipping a new app.
 *
 * SwapVM inverts that. The maker's terms ARE a program — fee, curve, deadline, control flow — and
 * the router executes them. A maker who wants a tighter band, a deadline, or a different curve
 * changes bytecode, not our contract. For tokenized equities that matters more than usual: a share
 * book wants a peg with a narrow band, and a crypto book wants a constant product, and those are
 * two programs rather than two deployments.
 *
 * This contract does not replace the Aqua book — it is a second venue, and `decide()` picks
 * between them from indexed liquidity.
 *
 * @dev The program format.
 *
 * A program is a concatenation of `[opcode:uint8][argsLength:uint8][args]`. The opcode is an index
 * into the router's own `_opcodes()` table. Those indices are hardcoded below because a program is
 * bytecode and cannot look them up at build time — and `XorrSwapVM.fork.t.sol` derives the same
 * bytes through the library's own `ProgramBuilder` and asserts equality, so a lib upgrade that
 * reorders the table fails a test rather than silently producing a program that prices wrong.
 */
contract XorrSwapVMBook {
    /// @notice Official Aqua registry. Same address on every chain Aqua ships to.
    IAqua public immutable AQUA;
    /// @notice Official AquaSwapVMRouter. Verified: its `AQUA()` returns the address above.
    ISwapVM public immutable SWAP_VM;
    /// @notice The permission contract every delegated fill is forced through.
    XorrDelegation public immutable DELEGATION;

    /**
     * Opcode indices in the DEPLOYED AquaSwapVMRouter's `_opcodes()` table.
     *
     * Determined empirically against the router on Base, not copied from lib/: the vendored
     * release's table is offset by one from the deployed one, which first surfaced as the VM
     * running a jump where a deadline was meant. `XorrSwapVM.fork.t.sol` asserts each of these by
     * BEHAVIOUR — the deadline must expire, the fee must cost — so a router upgrade that reorders
     * the table fails a test instead of silently repricing every book.
     */
    uint8 internal constant OP_DEADLINE = 13;
    uint8 internal constant OP_XYC_SWAP = 17;
    uint8 internal constant OP_SALT = 20;
    uint8 internal constant OP_FLAT_FEE = 21;
    uint8 internal constant OP_PEGGED_SWAP = 31;

    /**
     * SwapVM denominates fees in BILLIONTHS, not basis points — `BPS = 1e9` in its Fee library,
     * and the argument is a uint32, not a uint256.
     *
     * This API takes basis points because that is what a maker means and what the app shows, and
     * converts here. Passing 30 straight through would have set a fee of 30/1e9 — three ten-
     * thousandths of a basis point — and the maker would have quoted for free without noticing.
     */
    uint256 internal constant SWAPVM_FEE_DENOMINATOR = 1e9;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error NotAuthorisedOperator(address caller, address principal);
    error FeeTooHigh(uint256 feeBps);
    error DeadlineInPast(uint256 deadline);
    /// @notice A delegated fill named someone other than the owner whose capital is paying for it.
    error RecipientNotActiveOwner(address recipient, address activeOwner);

    /// @dev 10% is already absurd for a maker spread; past that it is a mistake, not a strategy.
    uint256 internal constant MAX_FEE_BPS = 1_000;

    event ProgramShipped(address indexed maker, bytes32 orderHash, bool pegged);
    event DelegatedFill(
        address indexed principal, bytes32 orderHash, address tokenIn, uint256 amountIn, uint256 amountOut
    );

    constructor(IAqua aqua, ISwapVM swapVM, XorrDelegation delegation) {
        AQUA = aqua;
        SWAP_VM = swapVM;
        DELEGATION = delegation;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Building the maker's program
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Basis points as SwapVM wants them: billionths, in a uint32.
    function _feeArg(uint256 feeBps) internal pure returns (uint32) {
        return uint32((feeBps * SWAPVM_FEE_DENOMINATOR) / BPS_DENOMINATOR);
    }

    /// @dev One instruction: opcode, then its argument length, then the arguments.
    function _instruction(uint8 opcode, bytes memory args) internal pure returns (bytes memory) {
        require(args.length <= type(uint8).max, "args too long");
        return abi.encodePacked(opcode, uint8(args.length), args);
    }

    /**
     * @notice A constant-product book with a maker fee and an expiry.
     * @dev The shape for crypto pairs, where there is no peg to hold — price is whatever the
     *      shipped balances imply, and the maker's edge is the spread.
     * @param feeBps The maker's spread, in basis points.
     * @param deadline Unix seconds after which the program refuses to fill. A book that cannot
     *        expire is a book the maker has to remember to dock.
     * @param salt Makes two otherwise identical books distinct orders.
     */
    function xycProgram(uint256 feeBps, uint40 deadline, bytes32 salt)
        public
        view
        returns (bytes memory)
    {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        if (deadline <= block.timestamp) revert DeadlineInPast(deadline);

        return bytes.concat(
            _instruction(OP_DEADLINE, abi.encodePacked(deadline)),
            feeBps > 0 ? _instruction(OP_FLAT_FEE, abi.encodePacked(_feeArg(feeBps))) : bytes(""),
            _instruction(OP_XYC_SWAP, ""),
            _instruction(OP_SALT, abi.encodePacked(salt))
        );
    }

    /**
     * @notice A pegged book: a narrow band around a reference price.
     * @dev The shape for a tokenized equity. A share tracks a price the market already agrees on,
     *      so the maker is not discovering it — they are quoting around it and taking the spread.
     *      A constant-product curve would let a large fill walk the price far from the share's real
     *      value, which is exactly what a maker of a pegged asset must not allow.
     *
     * @param x0 Normalised reserve of the lower-addressed token: balance * rateLt.
     * @param y0 Normalised reserve of the higher-addressed token: balance * rateGt.
     * @param linearWidth Linear coefficient scaled by 1e27 — how wide the band is before the curve
     *        bends away. Wider is more forgiving to takers and more dangerous to the maker.
     * @param rateLt Precision multiplier for the lower-addressed token.
     * @param rateGt Precision multiplier for the higher-addressed token.
     */
    function peggedProgram(
        uint256 x0,
        uint256 y0,
        uint256 linearWidth,
        uint256 rateLt,
        uint256 rateGt,
        uint256 feeBps,
        uint40 deadline,
        bytes32 salt
    ) public view returns (bytes memory) {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        if (deadline <= block.timestamp) revert DeadlineInPast(deadline);

        return bytes.concat(
            _instruction(OP_DEADLINE, abi.encodePacked(deadline)),
            feeBps > 0 ? _instruction(OP_FLAT_FEE, abi.encodePacked(_feeArg(feeBps))) : bytes(""),
            _instruction(OP_PEGGED_SWAP, abi.encodePacked(x0, y0, linearWidth, rateLt, rateGt)),
            _instruction(OP_SALT, abi.encodePacked(salt))
        );
    }

    /**
     * @notice Wrap a program into the order a maker ships.
     * @dev `useAquaInsteadOfSignature` is the whole point: the maker's authority comes from having
     *      shipped into Aqua, not from a signature we hold. Nobody can open a book in their name.
     */
    function orderFor(address maker, bytes memory program)
        public
        pure
        returns (ISwapVM.Order memory)
    {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /**
     * @notice Everything the MAKER needs to ship this book themselves.
     * @dev Same shape as XorrAquaBook.shipArgs, and for the same reason: Aqua keys a strategy to
     *      `msg.sender`, so the maker signs the ship. This contract computes; it never acts for
     *      them. Note the app is the SwapVM ROUTER, not this contract — the router is the Aqua app
     *      that executes the program.
     */
    function shipArgs(
        ISwapVM.Order memory order,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    )
        public
        view
        returns (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts)
    {
        app = address(SWAP_VM);
        encoded = abi.encode(order);
        tokens = new address[](2);
        tokens[0] = token0;
        tokens[1] = token1;
        amounts = new uint256[](2);
        amounts[0] = amount0;
        amounts[1] = amount1;
    }

    /// @notice The order hash Aqua and SwapVM both key this book by.
    function hashOf(ISwapVM.Order calldata order) external view returns (bytes32) {
        return SWAP_VM.hash(order);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Where SwapVM and XorrDelegation compose
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Take against a SwapVM book with the principal's delegated capital.
     * @dev Callable ONLY by XorrDelegation, so the daily cap, the expiry, the revocation flag and
     *      the venue allowlist are all enforced by the contract the user signed. The bot never
     *      calls this directly — it calls `spend()` with the calldata from `delegatedFillArgs`.
     *
     *      The delegation has pulled `amountIn` and approved this contract for exactly that, so we
     *      pull from it, approve the router, swap, and send the output straight to the principal.
     *      Nothing is left behind in either contract.
     */
    function fillForDelegation(
        ISwapVM.Order calldata order,
        address principal,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut) {
        if (msg.sender != address(DELEGATION)) revert NotAuthorisedOperator(msg.sender, principal);
        /*
         * The output goes to the owner whose capital is paying, and nobody else.
         *
         * `principal` came from calldata the delegate wrote, so a leaked delegate key could spend an
         * owner's cap here and name itself — `to: principal` below would then deliver the proceeds
         * to the thief. The delegation records whose trade is executing for exactly the length of
         * the venue call. PLAN.md 1.4.
         */
        address active = DELEGATION.activeOwner();
        if (principal != active) revert RecipientNotActiveOwner(principal, active);

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(address(SWAP_VM), amountIn);

        bytes memory takerData = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                // We hold the input and have approved the router, so the router should pull it and
                // push it into the maker's Aqua balance itself. Without this the VM prices the
                // fill, finds the maker's balance never grew, and reverts
                // AquaBalanceInsufficientAfterTakerPush.
                useTransferFromAndAquaPush: true,
                // The slippage floor. SwapVM enforces it, so a fill worse than this reverts inside
                // the VM rather than being noticed afterwards.
                threshold: amountOutMin > 0 ? abi.encodePacked(amountOutMin) : bytes(""),
                // Output goes to the user, never to us. This is the non-custodial claim in one field.
                to: principal,
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );

        bytes32 orderHash;
        (, amountOut, orderHash) = SWAP_VM.swap(order, tokenIn, tokenOut, amountIn, takerData);

        // Never leave a standing approval behind, exactly as XorrDelegation does not.
        IERC20(tokenIn).approve(address(SWAP_VM), 0);

        emit DelegatedFill(principal, orderHash, tokenIn, amountIn, amountOut);
    }

    /**
     * @notice The exact arguments the bot passes to `XorrDelegation.spend()` for this fill.
     * @dev Same pattern as the Aqua book: this contract computes the terms, and the call that
     *      moves money is made by whoever holds the authority to make it.
     */
    function delegatedFillArgs(
        ISwapVM.Order calldata order,
        address principal,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external view returns (address token, address venue, uint256 amount, bytes memory data) {
        return (
            tokenIn,
            address(this),
            amountIn,
            abi.encodeCall(
                this.fillForDelegation, (order, principal, tokenIn, tokenOut, amountIn, amountOutMin)
            )
        );
    }
}
