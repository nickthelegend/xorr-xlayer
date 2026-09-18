// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XorrDelegation, IERC20} from "../src/XorrDelegation.sol";

/// @dev Minimal ERC-20 for the tests. Real token semantics, no dependency.
contract MockUSDC {
    string public name = "Test USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * @dev Stands in for a DEX router: takes the token it was approved for, and pays the output to
 *      whoever the calldata names — exactly the freedom a real router gives the one who writes its
 *      calldata, which here is the delegate.
 */
contract MockVenue {
    MockUSDC public token;
    MockUSDC public output;
    XorrDelegation public del;
    uint256 public received;
    /// Whose trade the delegation said this was, as seen from inside the call.
    address public sawActiveOwner;

    constructor(MockUSDC t, MockUSDC out, XorrDelegation d) {
        token = t;
        output = out;
        del = d;
    }

    function swap(uint256 amount, address to, uint256 amountOut) external {
        token.transferFrom(msg.sender, address(this), amount);
        received += amount;
        sawActiveOwner = del.activeOwner();
        output.mint(to, amountOut);
    }
}

/**
 * A venue that fails the way a real router fails: with its own custom error carrying the number
 * that explains it. 1inch's `ReturnAmountIsNotEnough(uint256)` is the case that mattered — a fill
 * blocked by slippage came back to the user as "the venue rejected the order", which is true of
 * every possible failure and therefore useless.
 */
contract PickyVenue {
    error ReturnAmountIsNotEnough(uint256 got);

    function swap(uint256) external pure {
        revert ReturnAmountIsNotEnough(24_768_044);
    }
}

/** A venue that reverts with nothing at all — the one case there is genuinely nothing to bubble. */
contract SilentVenue {
    function swap(uint256) external pure {
        revert();
    }
}

contract XorrDelegationTest is Test {
    XorrDelegation internal del;
    MockUSDC internal usdc;
    /// A non-settlement asset, so a close can be tested for what it is: selling a holding.
    MockUSDC internal asset;
    /// Takes USDC, pays `asset` — a buy.
    MockVenue internal venue;
    /// Takes `asset`, pays USDC — somewhere real for a close to sell into.
    MockVenue internal assetVenue;
    MockVenue internal unlistedVenue;

    address internal owner = address(0xA11CE);
    address internal bot = address(0xB0B);
    address internal attacker = address(0xBAD);

    uint256 internal constant USD = 1e6;
    uint256 internal constant DAILY_CAP = 400 * USD;

    function setUp() public {
        usdc = new MockUSDC();
        asset = new MockUSDC();
        del = new XorrDelegation(address(usdc));
        venue = new MockVenue(usdc, asset, del);
        unlistedVenue = new MockVenue(usdc, asset, del);
        assetVenue = new MockVenue(asset, usdc, del);

        usdc.mint(owner, 10_000 * USD);

        address[] memory venues = new address[](1);
        venues[0] = address(venue);

        vm.startPrank(owner);
        // The owner approves the delegation contract to pull, and grants the policy.
        usdc.approve(address(del), type(uint256).max);
        del.grant(bot, DAILY_CAP, uint64(block.timestamp + 3 days), venues);
        del.setVenue(address(assetVenue), true);
        vm.stopPrank();
    }

    /// Calldata for a venue that takes `amountIn` and pays `amountOut` to `to`.
    function _pay(uint256 amountIn, address to, uint256 amountOut) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockVenue.swap.selector, amountIn, to, amountOut);
    }

    /// An honest buy: USDC in, the same number of `asset` units delivered to the owner.
    function _buy(address at, uint256 amount) internal returns (bytes memory) {
        return del.spend(owner, address(usdc), at, amount, address(asset), amount, _pay(amount, owner, amount));
    }

    /// An honest close: `asset` in, the same number of USDC units delivered to the owner.
    function _close(address at, uint256 amount) internal returns (bytes memory) {
        return del.closePosition(
            owner, address(asset), at, amount, address(usdc), amount, _pay(amount, owner, amount)
        );
    }

    function _holdAsset(uint256 amount) internal {
        asset.mint(owner, amount);
        vm.prank(owner);
        asset.approve(address(del), type(uint256).max);
    }

    // ── The grant ────────────────────────────────────────────────────────────

    function test_GrantStoresThePolicy() public view {
        (address delegate, uint256 cap, uint64 expiresAt, bool revoked) = del.policyOf(owner);
        assertEq(delegate, bot);
        assertEq(cap, DAILY_CAP);
        assertGt(expiresAt, block.timestamp);
        assertFalse(revoked);
        assertEq(del.remainingToday(owner), DAILY_CAP);
        assertEq(del.SETTLEMENT_TOKEN(), address(usdc));
    }

    function test_ASettlementTokenIsRequired() public {
        vm.expectRevert(bytes("settlement token required"));
        new XorrDelegation(address(0));
    }

    /**
     * A re-grant replaces the venue list; it does not add to it.
     *
     * The allowlist mapping cannot be enumerated, so a venue dropped from the app's list used to stay
     * allowed on chain forever — the user saw it gone and the contract still accepted it.
     */
    function test_ReGrantReplacesTheVenueList() public {
        assertTrue(del.isVenueAllowed(owner, address(venue)));
        assertTrue(del.isVenueAllowed(owner, address(assetVenue)));

        address[] memory only = new address[](1);
        only[0] = address(assetVenue);
        vm.prank(owner);
        del.grant(bot, DAILY_CAP, uint64(block.timestamp + 3 days), only);

        assertFalse(del.isVenueAllowed(owner, address(venue)), "a venue left off the new grant is still allowed");
        assertTrue(del.isVenueAllowed(owner, address(assetVenue)));

        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, address(venue)));
        _buy(address(venue), 10 * USD);
    }

    function test_ReGrantClearsAVenueToggledOffAndOnAgain() public {
        vm.startPrank(owner);
        del.setVenue(address(venue), false);
        del.setVenue(address(venue), true);
        del.grant(bot, DAILY_CAP, uint64(block.timestamp + 3 days), new address[](0));
        vm.stopPrank();

        assertFalse(del.isVenueAllowed(owner, address(venue)));
        assertFalse(del.isVenueAllowed(owner, address(assetVenue)));
    }

    // ── The bot can trade inside the cap ─────────────────────────────────────

    function test_BotCanSpendInsideTheCap() public {
        vm.prank(bot);
        _buy(address(venue), 100 * USD);

        assertEq(venue.received(), 100 * USD);
        assertEq(del.spentToday(owner), 100 * USD);
        assertEq(del.remainingToday(owner), 300 * USD);
        assertEq(usdc.balanceOf(owner), 9_900 * USD);
        assertEq(asset.balanceOf(owner), 100 * USD, "the output did not reach the owner");
    }

    function test_SeveralTradesAccumulateAgainstTheCap() public {
        vm.startPrank(bot);
        _buy(address(venue), 150 * USD);
        _buy(address(venue), 150 * USD);
        vm.stopPrank();
        assertEq(del.spentToday(owner), 300 * USD);
        assertEq(del.remainingToday(owner), 100 * USD);
    }

    // ── Where the output goes ────────────────────────────────────────────────

    /**
     * The drain this closes: the router pays whoever the calldata names, and the delegate writes the
     * calldata. A leaked delegate key used to be able to spend the day's cap and be paid for it.
     */
    function test_OutputMustReachTheOwner() public {
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.OutputNotReceived.selector, 0, 100 * USD));
        del.spend(
            owner, address(usdc), address(venue), 100 * USD, address(asset), 100 * USD, _pay(100 * USD, attacker, 100 * USD)
        );

        assertEq(asset.balanceOf(attacker), 0, "the attacker was paid");
        assertEq(usdc.balanceOf(owner), 10_000 * USD, "the owner paid for it");
        assertEq(del.spentToday(owner), 0, "a trade that reverted still counted against the cap");
    }

    function test_CloseProceedsMustReachTheOwner() public {
        _holdAsset(1e18);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.OutputNotReceived.selector, 0, 1e18));
        del.closePosition(owner, address(asset), address(assetVenue), 1e18, address(usdc), 1e18, _pay(1e18, attacker, 1e18));
        assertEq(asset.balanceOf(owner), 1e18, "the holding left without its proceeds");
    }

    function test_AShortChangedTradeReverts() public {
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.OutputNotReceived.selector, 60 * USD, 100 * USD));
        del.spend(owner, address(usdc), address(venue), 100 * USD, address(asset), 100 * USD, _pay(100 * USD, owner, 60 * USD));
    }

    function test_ATradeMustNameItsOutputAndAFloor() public {
        bytes memory honest = _pay(10 * USD, owner, 10 * USD);
        vm.startPrank(bot);
        vm.expectRevert(XorrDelegation.ZeroMinOut.selector);
        del.spend(owner, address(usdc), address(venue), 10 * USD, address(asset), 0, honest);
        vm.expectRevert(XorrDelegation.InvalidTokenOut.selector);
        del.spend(owner, address(usdc), address(venue), 10 * USD, address(usdc), 1, honest);
        vm.expectRevert(XorrDelegation.InvalidTokenOut.selector);
        del.spend(owner, address(usdc), address(venue), 10 * USD, address(0), 1, honest);
        vm.stopPrank();
    }

    /// The owner a venue call is for is visible to the venue during the call, and to nobody after it.
    function test_TheVenueSeesTheOwnerOnlyDuringTheCall() public {
        assertEq(del.activeOwner(), address(0));
        vm.prank(bot);
        _buy(address(venue), 10 * USD);
        assertEq(venue.sawActiveOwner(), owner, "the venue could not tell whose trade it was");
        assertEq(del.activeOwner(), address(0), "the active owner outlived the call");
    }

    // ── THE DAILY CAP IS ENFORCED BY THIS CONTRACT ───────────────────────────

    function test_SpendOverTheDailyCapReverts() public {
        vm.prank(bot);
        _buy(address(venue), 350 * USD);

        // 50 left. Asking for 51 must fail.
        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(XorrDelegation.DailyCapExceeded.selector, 51 * USD, 50 * USD)
        );
        _buy(address(venue), 51 * USD);

        // And nothing moved.
        assertEq(del.spentToday(owner), 350 * USD);
        assertEq(usdc.balanceOf(owner), 9_650 * USD);
    }

    /// @notice The improvement over the Solana build: the cap RESETS on the UTC day boundary,
    ///         on-chain, rather than being tracked by the executor.
    function test_TheCapResetsTheNextDay() public {
        vm.prank(bot);
        _buy(address(venue), DAILY_CAP);
        assertEq(del.remainingToday(owner), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(del.remainingToday(owner), DAILY_CAP);
        assertEq(del.spentToday(owner), 0);

        vm.prank(bot);
        _buy(address(venue), 10 * USD);
        assertEq(del.spentToday(owner), 10 * USD);
    }

    // ── Venue allowlist ──────────────────────────────────────────────────────

    function test_TheBotCannotTradeAtAnUnlistedVenue() public {
        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, address(unlistedVenue))
        );
        _buy(address(unlistedVenue), 10 * USD);
        assertEq(usdc.balanceOf(owner), 10_000 * USD);
    }

    /// @notice This is the "it cannot move your money out" promise on the delegation screen.
    function test_TheBotCannotSendFundsToAnAddressItChooses() public {
        // An EOA the bot controls is not an allowlisted venue, so there is no path to it.
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, attacker));
        del.spend(owner, address(usdc), attacker, 10 * USD, address(asset), 1, "");
        assertEq(usdc.balanceOf(attacker), 0);
    }

    // ── Who may call ─────────────────────────────────────────────────────────

    function test_OnlyTheDelegateCanSpend() public {
        vm.prank(attacker);
        vm.expectRevert(XorrDelegation.NotDelegate.selector);
        _buy(address(venue), 10 * USD);
    }

    // ── Expiry — screen 4's "Run For" is a real deadline ─────────────────────

    function test_SpendAfterExpiryReverts() public {
        vm.warp(block.timestamp + 4 days);
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyExpired.selector);
        _buy(address(venue), 10 * USD);
        assertEq(del.remainingToday(owner), 0);
    }

    // ── The kill switch ──────────────────────────────────────────────────────

    function test_RevokeStopsTheBotImmediately() public {
        vm.prank(owner);
        del.revoke();

        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyRevoked.selector);
        _buy(address(venue), 1 * USD);
    }

    /// @notice Screen 20 promises the funds are untouched when you stop the agents.
    function test_RevokeDoesNotTouchTheBalance() public {
        vm.prank(bot);
        _buy(address(venue), 100 * USD);
        uint256 before = usdc.balanceOf(owner);

        vm.prank(owner);
        del.revoke();

        assertEq(usdc.balanceOf(owner), before);
        assertEq(del.remainingToday(owner), 0);
    }

    function test_OnlyTheOwnerCanRevokeTheirOwnPolicy() public {
        // An attacker calling revoke() only revokes THEIR policy, never the owner's.
        vm.prank(attacker);
        del.revoke();

        (, , , bool revoked) = del.policyOf(owner);
        assertFalse(revoked);

        vm.prank(bot);
        _buy(address(venue), 1 * USD);
        assertEq(venue.received(), 1 * USD);
    }

    // ── No standing approvals ────────────────────────────────────────────────

    function test_NoApprovalIsLeftBehindAfterATrade() public {
        vm.prank(bot);
        _buy(address(venue), 100 * USD);
        assertEq(usdc.allowance(address(del), address(venue)), 0);
        // And the contract custodies nothing between trades.
        assertEq(usdc.balanceOf(address(del)), 0);
    }

    // ── Fuzz: the cap can never be exceeded, for any amount ──────────────────

    function testFuzz_TheCapIsNeverExceeded(uint256 amount) public {
        amount = bound(amount, 1, 10_000 * USD);
        vm.prank(bot);
        if (amount > DAILY_CAP) {
            vm.expectRevert();
            _buy(address(venue), amount);
            assertEq(del.spentToday(owner), 0);
        } else {
            _buy(address(venue), amount);
            assertLe(del.spentToday(owner), DAILY_CAP);
        }
    }

    // ── Closing is separately authorised, and separately bounded ────────────

    function test_CloseSellsWithoutTouchingTheDailyCap() public {
        // A stop that a spending limit can silence is not a stop. Use the cap up first, then
        // close: the close must still work.
        vm.prank(bot);
        _buy(address(venue), DAILY_CAP);
        assertEq(del.remainingToday(owner), 0, "cap should be exhausted");

        _holdAsset(1e18);
        uint256 usdcBefore = usdc.balanceOf(owner);

        vm.prank(bot);
        _close(address(assetVenue), 1e18);

        assertEq(asset.balanceOf(owner), DAILY_CAP, "the asset was not sold");
        assertEq(usdc.balanceOf(owner), usdcBefore + 1e18, "the proceeds did not reach the owner");
        // Still zero, not negative and not reset: closing is not spending.
        assertEq(del.remainingToday(owner), 0, "closing moved the spend cap");
    }

    /// Closing is uncapped, so it may not sell the asset the cap is there to limit.
    function test_CloseRefusesTheSettlementToken() public {
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.SettlementTokenNotClosable.selector);
        del.closePosition(
            owner, address(usdc), address(venue), 100 * USD, address(asset), 100 * USD, _pay(100 * USD, owner, 100 * USD)
        );
        assertEq(usdc.balanceOf(owner), 10_000 * USD);
    }

    function test_CloseObeysTheVenueAllowlist() public {
        _holdAsset(1e18);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, address(0xBAD)));
        del.closePosition(owner, address(asset), address(0xBAD), 1e18, address(usdc), 1, "");
    }

    function test_CloseStopsWhenRevoked() public {
        _holdAsset(1e18);
        vm.prank(owner);
        del.revoke();

        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyRevoked.selector);
        _close(address(assetVenue), 1e18);
    }

    function test_OnlyTheDelegateCanClose() public {
        _holdAsset(1e18);
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(XorrDelegation.NotDelegate.selector);
        _close(address(assetVenue), 1e18);
    }

    function test_CloseLeavesNoStandingApproval() public {
        _holdAsset(1e18);
        vm.prank(bot);
        _close(address(assetVenue), 1e18);
        assertEq(asset.allowance(address(del), address(assetVenue)), 0, "approval left behind");
    }

    /**
     * The venue's own error survives the delegation.
     *
     * `revert VenueCallFailed()` replaced whatever the venue said, so a slippage failure, an empty
     * pool and malformed calldata all reached the user as one sentence. Bubbling the raw revert is
     * what lets the executor translate `ReturnAmountIsNotEnough` into "the price moved more than
     * your slippage limit" — a thing the user can act on.
     */
    function test_VenueRevertReasonSurvivesSpend() public {
        PickyVenue picky = new PickyVenue();
        vm.prank(owner);
        del.setVenue(address(picky), true);

        bytes memory data = abi.encodeWithSignature("swap(uint256)", uint256(1));
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(PickyVenue.ReturnAmountIsNotEnough.selector, 24_768_044));
        del.spend(owner, address(usdc), address(picky), 10e6, address(asset), 1, data);
    }

    function test_VenueRevertReasonSurvivesClose() public {
        PickyVenue picky = new PickyVenue();
        vm.prank(owner);
        del.setVenue(address(picky), true);
        _holdAsset(10e6);

        bytes memory data = abi.encodeWithSignature("swap(uint256)", uint256(1));
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(PickyVenue.ReturnAmountIsNotEnough.selector, 24_768_044));
        del.closePosition(owner, address(asset), address(picky), 10e6, address(usdc), 1, data);
    }

    /** With nothing to bubble, the named error is still the honest answer. */
    function test_SilentVenueStillReportsVenueCallFailed() public {
        SilentVenue silent = new SilentVenue();
        vm.prank(owner);
        del.setVenue(address(silent), true);

        bytes memory data = abi.encodeWithSignature("swap(uint256)", uint256(1));
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.VenueCallFailed.selector);
        del.spend(owner, address(usdc), address(silent), 10e6, address(asset), 1, data);
    }
}
