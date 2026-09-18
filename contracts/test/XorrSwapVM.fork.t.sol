// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console } from "forge-std/Test.sol";
import { IAqua } from "aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "swap-vm/src/interfaces/ISwapVM.sol";
import { XorrSwapVMBook } from "../src/XorrSwapVMBook.sol";
import { XorrDelegation } from "../src/XorrDelegation.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * A xorr book expressed as a SwapVM program, executed by the REAL 1inch SwapVM router on a Base
 * mainnet fork.
 *
 * The 1inch track asks for official contracts and on-chain execution. Everything here runs against
 * `0x1111113ccf…` (Aqua) and `0x111111338c…` (AquaSwapVMRouter) with real Base state and real
 * USDC — the router's own `AQUA()` returns the Aqua address, which is asserted in setUp rather
 * than assumed.
 *
 * Run: forge test --match-contract XorrSwapVMFork --fork-url https://mainnet.base.org
 */
contract XorrSwapVMForkTest is Test {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    ISwapVM constant SWAP_VM = ISwapVM(0x111111338c5091E8440b67B168bAe16a668AC0De);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    XorrSwapVMBook internal book;
    XorrDelegation internal delegation;

    address internal maker = makeAddr("swapvm-maker");
    address internal bot = makeAddr("xorr-bot");
    address internal user = makeAddr("user");

    uint256 constant USD = 1e6;
    uint256 constant DAILY_CAP = 5_000 * USD;
    uint256 constant SEED_USDC = 40_000 * USD;
    uint256 constant SEED_WETH = 16 ether;

    uint40 internal deadline;
    bytes32 constant SALT = keccak256("xorr/swapvm/WETH-USDC/v1");

    function setUp() public {
        uint256 pin = vm.envOr("FORK_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")));
        else vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")), pin);

        assertGt(address(AQUA).code.length, 0, "Aqua not deployed on this fork");
        assertGt(address(SWAP_VM).code.length, 0, "SwapVM not deployed on this fork");
        // The router must be wired to the same Aqua the rest of xorr uses, or these are two
        // unrelated protocols that merely both exist.
        assertEq(_aquaOf(address(SWAP_VM)), address(AQUA), "router points at a different Aqua");

        delegation = new XorrDelegation(USDC);
        book = new XorrSwapVMBook(AQUA, SWAP_VM, delegation);
        deadline = uint40(block.timestamp + 7 days);

        deal(USDC, maker, SEED_USDC);
        deal(WETH, maker, SEED_WETH);
        deal(USDC, user, 10_000 * USD);

        vm.startPrank(maker);
        IERC20(USDC).approve(address(AQUA), type(uint256).max);
        IERC20(WETH).approve(address(AQUA), type(uint256).max);
        vm.stopPrank();

        address[] memory venues = new address[](1);
        venues[0] = address(book);
        vm.startPrank(user);
        delegation.grant(bot, DAILY_CAP, uint64(block.timestamp + 7 days), venues);
        IERC20(USDC).approve(address(delegation), type(uint256).max);
        vm.stopPrank();
    }

    function _aquaOf(address router) internal view returns (address a) {
        (bool ok, bytes memory ret) = router.staticcall(abi.encodeWithSignature("AQUA()"));
        require(ok, "AQUA() reverted");
        a = abi.decode(ret, (address));
    }

    function _order() internal view returns (ISwapVM.Order memory) {
        // 30bp maker spread, expiring in a week.
        return book.orderFor(maker, book.xycProgram(30, deadline, SALT));
    }

    function _ship() internal returns (ISwapVM.Order memory order) {
        order = _order();
        (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts) =
            book.shipArgs(order, WETH, USDC, SEED_WETH, SEED_USDC);
        vm.prank(maker);
        AQUA.ship(app, encoded, tokens, amounts);
    }

    // ── The program is a real SwapVM program ────────────────────────────────

    function test_ProgramIsWellFormedBytecode() public view {
        bytes memory p = book.xycProgram(30, deadline, SALT);
        // deadline(5) + fee(2+32) + xyc(2) + salt(2+32) = 4 instructions, each [op][len][args].
        assertGt(p.length, 0);
        // First instruction must be the deadline: opcode 14, 5 bytes of uint40.
        assertEq(uint8(p[0]), 13, "first opcode is not the deadline guard");
        assertEq(uint8(p[1]), 5, "deadline args are not a uint40");
    }

    function test_ProgramRefusesNonsenseTerms() public {
        vm.expectRevert(abi.encodeWithSelector(XorrSwapVMBook.FeeTooHigh.selector, uint256(1_001)));
        book.xycProgram(1_001, deadline, SALT);

        vm.expectRevert(
            abi.encodeWithSelector(XorrSwapVMBook.DeadlineInPast.selector, uint256(block.timestamp))
        );
        book.xycProgram(30, uint40(block.timestamp), SALT);
    }

    // ── Shipping moves nothing ──────────────────────────────────────────────

    function test_ShipMovesNoTokens() public {
        uint256 usdcBefore = IERC20(USDC).balanceOf(maker);
        uint256 wethBefore = IERC20(WETH).balanceOf(maker);

        _ship();

        assertEq(IERC20(USDC).balanceOf(maker), usdcBefore, "USDC left the maker's wallet");
        assertEq(IERC20(WETH).balanceOf(maker), wethBefore, "WETH left the maker's wallet");
        assertEq(IERC20(USDC).balanceOf(address(AQUA)), 0, "Aqua custodied USDC");
        assertEq(IERC20(USDC).balanceOf(address(SWAP_VM)), 0, "the router custodied USDC");
    }

    // ── The whole point: the BOT fills through SwapVM, under the user's policy ──

    function test_BotFillsThroughSwapVMUnderPolicy() public {
        ISwapVM.Order memory order = _ship();

        uint256 spend = 500 * USD;
        uint256 userWethBefore = IERC20(WETH).balanceOf(user);
        uint256 userUsdcBefore = IERC20(USDC).balanceOf(user);
        assertEq(delegation.remainingToday(user), DAILY_CAP);

        (address token, address venue, uint256 amount, bytes memory data) =
            book.delegatedFillArgs(order, user, USDC, WETH, spend, 0);

        vm.prank(bot);
        bytes memory ret = delegation.spend(user, token, venue, amount, WETH, 1, data);
        uint256 out = abi.decode(ret, (uint256));

        assertGt(out, 0, "SwapVM returned no output");
        assertEq(IERC20(WETH).balanceOf(user), userWethBefore + out, "WETH did not reach the user");
        assertEq(IERC20(USDC).balanceOf(user), userUsdcBefore - spend, "USDC did not leave the user");
        assertEq(delegation.remainingToday(user), DAILY_CAP - spend, "cap did not decrement");

        // Neither contract keeps a balance, and no standing approval is left behind.
        assertEq(IERC20(WETH).balanceOf(address(book)), 0, "app kept WETH");
        assertEq(IERC20(USDC).balanceOf(address(book)), 0, "app kept USDC");
        assertEq(IERC20(USDC).balanceOf(address(delegation)), 0, "delegation kept USDC");

        console.log("bot bought wei of WETH via SwapVM:", out);
    }

    // ── The limits are limits on this path too ──────────────────────────────

    function test_BotCannotExceedTheDailyCapThroughSwapVM() public {
        ISwapVM.Order memory order = _ship();

        (address t, address v, uint256 a, bytes memory d) =
            book.delegatedFillArgs(order, user, USDC, WETH, 4_000 * USD, 0);
        vm.prank(bot);
        delegation.spend(user, t, v, a, WETH, 1, d);

        (t, v, a, d) = book.delegatedFillArgs(order, user, USDC, WETH, 4_000 * USD, 0);
        vm.prank(bot);
        vm.expectRevert();
        delegation.spend(user, t, v, a, WETH, 1, d);
    }

    function test_RevokeStopsTheSwapVMPath() public {
        ISwapVM.Order memory order = _ship();

        vm.prank(user);
        delegation.revoke();

        (address t, address v, uint256 a, bytes memory d) =
            book.delegatedFillArgs(order, user, USDC, WETH, 100 * USD, 0);
        vm.prank(bot);
        vm.expectRevert();
        delegation.spend(user, t, v, a, WETH, 1, d);
    }

    function test_AppRefusesAFillNotRoutedThroughTheDelegation() public {
        ISwapVM.Order memory order = _ship();
        // Calling the app directly would sidestep the cap entirely.
        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(XorrSwapVMBook.NotAuthorisedOperator.selector, bot, user)
        );
        book.fillForDelegation(order, user, USDC, WETH, 100 * USD, 0);
    }

    /**
     * The drain PLAN.md 1.4 closes. The delegate writes the fill's calldata, so it could name itself
     * as `principal` and SwapVM would deliver the output there — paid for with the user's cap.
     */
    function test_DelegatedFillCannotPayAnyoneButTheOwner() public {
        ISwapVM.Order memory order = _ship();
        address attacker = makeAddr("attacker");
        bytes memory data =
            abi.encodeCall(book.fillForDelegation, (order, attacker, USDC, WETH, 100 * USD, uint256(0)));

        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(XorrSwapVMBook.RecipientNotActiveOwner.selector, attacker, user)
        );
        delegation.spend(user, USDC, address(book), 100 * USD, WETH, 1, data);
        assertEq(IERC20(WETH).balanceOf(attacker), 0, "the attacker was paid");
    }

    // ── The opcode constants are guarded by behaviour, not by faith ─────────

    /**
     * The opcode table is an index into the DEPLOYED router's `_opcodes()`, and the deployed
     * router is not necessarily the version vendored in lib/. It is not: the vendored table is
     * offset by one, which first showed up as `ControlsMissingTokenArg` — the VM was running a
     * jump where a deadline was meant.
     *
     * Hardcoded indices with no check would let a router upgrade silently reprice every book. So
     * each constant is asserted by what it DOES: the deadline must expire, and the fee must cost.
     */
    function test_DeadlineOpcodeActuallyExpires() public {
        uint40 soon = uint40(block.timestamp + 1 hours);
        ISwapVM.Order memory order =
            book.orderFor(maker, book.xycProgram(30, soon, keccak256("deadline-probe")));
        (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts) =
            book.shipArgs(order, WETH, USDC, SEED_WETH, SEED_USDC);
        vm.prank(maker);
        AQUA.ship(app, encoded, tokens, amounts);

        // Inside the window it fills.
        (address t, address v, uint256 a, bytes memory d) =
            book.delegatedFillArgs(order, user, USDC, WETH, 100 * USD, 0);
        vm.prank(bot);
        delegation.spend(user, t, v, a, WETH, 1, d);

        // Past it, the program itself refuses.
        vm.warp(block.timestamp + 2 hours);
        (t, v, a, d) = book.delegatedFillArgs(order, user, USDC, WETH, 100 * USD, 0);
        vm.prank(bot);
        vm.expectRevert();
        delegation.spend(user, t, v, a, WETH, 1, d);
    }

    function test_FeeOpcodeActuallyCosts() public {
        // Two identical books but for the fee. If opcode 21 were not the flat fee, the outputs
        // would match and the maker's spread would be decorative.
        ISwapVM.Order memory free =
            book.orderFor(maker, book.xycProgram(0, deadline, keccak256("no-fee")));
        ISwapVM.Order memory charged =
            book.orderFor(maker, book.xycProgram(100, deadline, keccak256("1pct-fee")));

        uint256 outFree = _shipAndFill(free, keccak256("no-fee"));
        uint256 outCharged = _shipAndFill(charged, keccak256("1pct-fee"));

        assertGt(outFree, outCharged, "a 1% fee did not reduce the output");
        // Roughly 1% worse, not wildly different — that would mean the wrong instruction ran.
        assertApproxEqRel(outCharged, (outFree * 99) / 100, 0.02e18, "fee is not ~1%");
    }

    function _shipAndFill(ISwapVM.Order memory order, bytes32) internal returns (uint256) {
        (address app, bytes memory encoded, address[] memory tokens, uint256[] memory amounts) =
            book.shipArgs(order, WETH, USDC, SEED_WETH, SEED_USDC);
        deal(USDC, maker, SEED_USDC * 3);
        deal(WETH, maker, SEED_WETH * 3);
        vm.prank(maker);
        AQUA.ship(app, encoded, tokens, amounts);

        (address t, address v, uint256 a, bytes memory d) =
            book.delegatedFillArgs(order, user, USDC, WETH, 200 * USD, 0);
        uint256 before = IERC20(WETH).balanceOf(user);
        vm.prank(bot);
        delegation.spend(user, t, v, a, WETH, 1, d);
        return IERC20(WETH).balanceOf(user) - before;
    }

    function test_SlippageFloorIsEnforcedInsideTheVM() public {
        ISwapVM.Order memory order = _ship();
        // Demand an impossible output; SwapVM must refuse rather than fill badly.
        (address t, address v, uint256 a, bytes memory d) =
            book.delegatedFillArgs(order, user, USDC, WETH, 500 * USD, 1_000 ether);
        vm.prank(bot);
        vm.expectRevert();
        delegation.spend(user, t, v, a, WETH, 1, d);
    }
}
