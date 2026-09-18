// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console } from "forge-std/Test.sol";
import { IAqua } from "aqua/src/interfaces/IAqua.sol";
import { XorrAquaBook } from "../src/XorrAquaBook.sol";
import { XorrDelegation } from "../src/XorrDelegation.sol";

/// @dev Backed's issuance surface — the issuer mints shares against custodied stock.
interface IBackedToken {
    function minter() external view returns (address);
    function mint(address to, uint256 amount) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * Tokenized equities, traded by the bot, on real Base state.
 *
 * Why Aqua and not an AMM: the tokenized-stock market on Base is real but thin. Some issues have
 * an aggregator route; others — Backed's bNVDA among them — have real supply and real holders and
 * no pool an aggregator will quote. An AMM answer would be "list it and hope somebody LPs it",
 * which means locking capital in a pool for an asset that trades a few hours a day.
 *
 * Aqua is the shape that actually fits: a market maker keeps the shares and the USDC in their own
 * wallet, ships a book, and quotes. Nothing is escrowed, so quoting an illiquid instrument costs
 * them nothing but the risk they chose. That is what makes "buy $250 of NVIDIA from your phone"
 * possible on chain without waiting for someone to seed a pool.
 *
 * The other half is XorrDelegation: the bot places the trade while the user is asleep, inside a
 * cap the user set, at a venue the user allowlisted. This test runs both halves together, which is
 * the only configuration that matters — either alone is a demo.
 *
 * Run: forge test --match-contract XorrStocksFork --fork-url https://mainnet.base.org
 */
contract XorrStocksForkTest is Test {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /**
     * Backed's bNVDA — a real ERC-20 on Base tracking NVIDIA, 18 decimals, ~7,000 tokens issued.
     *
     * Deliberately NOT Ondo's NVDAc: that one has deeper liquidity but its account code is the
     * single byte 0xef, i.e. it is implemented natively in the Base node rather than in EVM
     * bytecode. Nothing that runs on a fork can call it — anvil and revm both halt on
     * OpcodeNotFound — so it can be quoted honestly but never executed anywhere except mainnet.
     * bNVDA is ordinary bytecode and therefore actually provable here.
     */
    address constant BNVDA = 0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495;

    XorrAquaBook internal book;
    XorrDelegation internal delegation;

    address internal maker = makeAddr("stock-maker");
    address internal bot = makeAddr("xorr-bot");
    address internal user = makeAddr("user");

    uint256 constant USD = 1e6;
    uint256 constant DAILY_CAP = 2_000 * USD;

    /// NVIDIA around $232/share. `rawReferencePrice` wants the human price scaled by 1e18.
    uint256 constant SHARE_PRICE_USD = 232e18;

    /**
     * The maker's book. The two sides must imply the reference price, because that is what the
     * book quotes from: seeding 20 shares against 8,000 USDC implies $400/share, and every fill
     * would then be rejected as outside the band no matter what reference was configured.
     */
    uint256 constant SEED_SHARES = 200e18;
    uint256 constant SEED_USDC = (SEED_SHARES * SHARE_PRICE_USD) / 1e18 / 1e12; // -> USDC 6dp

    XorrAquaBook.Strategy internal strat;

    function setUp() public {
        uint256 pin = vm.envOr("FORK_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")));
        else vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")), pin);

        assertGt(address(AQUA).code.length, 0, "Aqua not deployed on this fork");
        // If this ever fails, the equity token stopped being ordinary EVM code and the whole
        // execution path needs re-proving rather than silently degrading.
        assertGt(BNVDA.code.length, 1, "bNVDA is not EVM bytecode on this fork");

        delegation = new XorrDelegation(USDC);
        book = new XorrAquaBook(AQUA, delegation);

        _mintShares(maker, SEED_SHARES);
        deal(USDC, maker, SEED_USDC);
        deal(USDC, user, 5_000 * USD);

        strat = XorrAquaBook.Strategy({
            maker: maker,
            token0: BNVDA,
            token1: USDC,
            feeBps: 30,
            maxDeviationBps: 500,
            referencePrice: book.rawReferencePrice(SHARE_PRICE_USD, 18, 6),
            salt: keccak256("xorr/bNVDA-USDC/v1")
        });

        // The maker's side: one approval, tokens stay put.
        vm.startPrank(maker);
        IERC20(BNVDA).approve(address(AQUA), type(uint256).max);
        IERC20(USDC).approve(address(AQUA), type(uint256).max);
        vm.stopPrank();

        // The user's side: a capped, expiring permission, allowlisted to this venue only.
        address[] memory venues = new address[](1);
        venues[0] = address(book);
        vm.startPrank(user);
        delegation.grant(bot, DAILY_CAP, uint64(block.timestamp + 7 days), venues);
        IERC20(USDC).approve(address(delegation), type(uint256).max);
        vm.stopPrank();
    }

    /**
     * Give the maker real shares the way real shares come into existence: the issuer mints them.
     *
     * `deal` cannot do it — bNVDA is a transparent upgradeable proxy whose balance mapping is not
     * at any small slot, and a hardcoded slot would break silently on the next upgrade. Backed's
     * token exposes `minter()`, so prank the actual minter instead. That is both more robust and a
     * truer picture: shares exist because an issuer issued them against custodied stock.
     */
    function _mintShares(address to, uint256 amount) internal {
        address minter = IBackedToken(BNVDA).minter();
        assertTrue(minter != address(0), "bNVDA has no minter");
        uint256 before = IERC20(BNVDA).balanceOf(to);
        vm.prank(minter);
        IBackedToken(BNVDA).mint(to, amount);
        // The token accounts in shares, so a mint can land a wei short of the requested amount.
        // Assert the credit arrived, not that it arrived to the wei.
        uint256 credited = IERC20(BNVDA).balanceOf(to) - before;
        assertApproxEqAbs(credited, amount, 2, "mint did not credit the maker");
    }

    /**
     * How the bot actually places a delegated fill: it asks the app for the terms, then calls
     * XorrDelegation.spend(), which is where the cap, the expiry, the revocation flag and the
     * venue allowlist are enforced. The bot never moves the principal's tokens itself.
     */
    function _fillArgs(address principal, bool zeroForOne, uint256 amountIn, uint256 amountOutMin)
        internal
        view
        returns (address token, address venue, uint256 amount, bytes memory data)
    {
        return book.delegatedFillArgs(strat, principal, zeroForOne, amountIn, amountOutMin);
    }

    function _botFill(address principal, bool zeroForOne, uint256 amountIn, uint256 amountOutMin)
        internal
        returns (uint256)
    {
        (address token, address venue, uint256 amount, bytes memory data) =
            _fillArgs(principal, zeroForOne, amountIn, amountOutMin);
        vm.prank(bot);
        // spend() hands back the venue's raw return data, which for fillForDelegation is a uint256.
        return abi.decode(
            delegation.spend(principal, token, venue, amount, _outOf(zeroForOne), _floor(amountOutMin), data),
            (uint256)
        );
    }

    /// @dev Same call, but with `vm.expectRevert` landing on `spend` rather than on the view that
    ///      prepares its arguments.
    function _botFillExpectRevert(address principal, uint256 amountIn) internal {
        (address token, address venue, uint256 amount, bytes memory data) =
            _fillArgs(principal, false, amountIn, 0);
        vm.prank(bot);
        vm.expectRevert();
        delegation.spend(principal, token, venue, amount, _outOf(false), 1, data);
    }

    /// The token a fill in this direction delivers — what `spend()` measures at the principal.
    function _outOf(bool zeroForOne) internal view returns (address) {
        return zeroForOne ? strat.token1 : strat.token0;
    }

    /**
     * The floor `spend()` holds the principal's balance to (PLAN.md 1.4), never zero.
     *
     * Two wei under the book's own minimum, because bNVDA accounts in shares and a transfer can land a
     * wei or two short of the amount sent — the same tolerance the assertions below already allow.
     */
    function _floor(uint256 amountOutMin) internal pure returns (uint256) {
        return amountOutMin > 2 ? amountOutMin - 2 : 1;
    }

    function _ship() internal {
        (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts) =
            book.shipArgs(strat, SEED_SHARES, SEED_USDC);
        vm.prank(maker);
        AQUA.ship(app, encoded, tokens, amounts);
    }

    // ── The market maker can quote a stock without parking a cent ────────────

    function test_MakerQuotesSharesWithoutLockingThem() public {
        uint256 sharesBefore = IERC20(BNVDA).balanceOf(maker);
        uint256 usdcBefore = IERC20(USDC).balanceOf(maker);

        _ship();

        assertEq(IERC20(BNVDA).balanceOf(maker), sharesBefore, "shares left the maker's wallet");
        assertEq(IERC20(USDC).balanceOf(maker), usdcBefore, "USDC left the maker's wallet");
        assertEq(IERC20(BNVDA).balanceOf(address(AQUA)), 0, "Aqua custodied shares");
        assertEq(IERC20(BNVDA).balanceOf(address(book)), 0, "the app custodied shares");

        (uint256 shares, uint256 usdc) = book.bookBalances(strat);
        assertEq(shares, SEED_SHARES);
        assertEq(usdc, SEED_USDC);
        assertTrue(book.isOpen(strat));
    }

    // ── A user buying a share directly ──────────────────────────────────────

    function test_UserBuysAShare() public {
        _ship();

        uint256 spend = 250 * USD;
        uint256 expected = book.quoteExactIn(strat, false, spend);
        assertGt(expected, 0, "no quote for the share");

        uint256 userSharesBefore = IERC20(BNVDA).balanceOf(user);
        uint256 makerUsdcBefore = IERC20(USDC).balanceOf(maker);

        vm.startPrank(user);
        IERC20(USDC).approve(address(book), spend);
        uint256 out = book.swapExactIn(strat, false, spend, expected, user);
        vm.stopPrank();

        assertEq(out, expected, "quote and fill disagree");
        // bNVDA accounts in shares, so a transfer can land a wei short of the amount requested.
        assertApproxEqAbs(
            IERC20(BNVDA).balanceOf(user), userSharesBefore + out, 2, "user did not receive shares"
        );
        assertEq(IERC20(USDC).balanceOf(maker), makerUsdcBefore + spend, "maker was not paid");

        // ~$250 at ~$232/share, less a 30bp fee: a bit over one share.
        assertGt(out, 1e18, "less than a share for $250");
        assertLt(out, 1.2e18, "implausibly many shares for $250");
    }

    // ── The whole thesis: the BOT buys the share, inside the user's limits ───

    function test_BotBuysAShareForTheUserUnderPolicy() public {
        _ship();

        uint256 spend = 250 * USD;
        uint256 expected = book.quoteExactIn(strat, false, spend);

        uint256 userUsdcBefore = IERC20(USDC).balanceOf(user);
        uint256 userSharesBefore = IERC20(BNVDA).balanceOf(user);
        assertEq(delegation.remainingToday(user), DAILY_CAP);

        // The user is not present. The bot signs; the contract decides whether it may.
        uint256 out = _botFill(user, false, spend, expected);

        assertEq(out, expected, "delegated fill differs from the quote");
        assertApproxEqAbs(
            IERC20(BNVDA).balanceOf(user), userSharesBefore + out, 2, "shares did not reach the user"
        );
        assertEq(IERC20(USDC).balanceOf(user), userUsdcBefore - spend, "USDC did not leave the user");
        assertEq(delegation.remainingToday(user), DAILY_CAP - spend, "cap did not decrement");

        // Nothing is left behind in either contract.
        assertEq(IERC20(BNVDA).balanceOf(address(book)), 0, "app kept shares");
        assertEq(IERC20(USDC).balanceOf(address(delegation)), 0, "delegation kept USDC");
        assertEq(IERC20(BNVDA).balanceOf(address(delegation)), 0, "delegation kept shares");

        console.log("bot bought shares (1e18):", out);
    }

    // ── The limits are limits, not labels ───────────────────────────────────

    function test_BotCannotExceedTheDailyCap() public {
        _ship();

        uint256 spend = 1_500 * USD;
        _botFill(user, false, spend, 0);
        assertEq(delegation.remainingToday(user), DAILY_CAP - spend);

        // The second trade would take it past the cap the user set.
        _botFillExpectRevert(user, spend);
    }

    function test_RevokedPolicyStopsTheBotMidDay() public {
        _ship();

        _botFill(user, false, 100 * USD, 0);

        // The user takes the permission back without our cooperation.
        vm.prank(user);
        delegation.revoke();

        _botFillExpectRevert(user, 100 * USD);
    }

    function test_BotCannotBuyAtAVenueTheUserDidNotAllow() public {
        _ship();

        // A second book — same code, different app address, never allowlisted by this user.
        // The delegation must refuse it even though the bot is a valid delegate for this user.
        XorrAquaBook rogue = new XorrAquaBook(AQUA, delegation);
        bytes memory data = abi.encodeCall(
            rogue.fillForDelegation, (strat, user, false, 100 * USD, uint256(0))
        );
        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, address(rogue))
        );
        delegation.spend(user, USDC, address(rogue), 100 * USD, BNVDA, 1, data);
    }

    function test_PriceBandRejectsAnAbsurdFill() public {
        _ship();

        // Draining most of the book must push the price outside the maker's 5% band and revert,
        // rather than filling a stock trade at an arbitrary price. Checked on the direct path so
        // the revert is the band, not the daily cap.
        vm.startPrank(user);
        IERC20(USDC).approve(address(book), type(uint256).max);
        vm.expectRevert();
        book.swapExactIn(strat, false, 4_000 * USD, 0, user);
        vm.stopPrank();
    }
}
