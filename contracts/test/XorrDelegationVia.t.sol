// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XorrDelegation} from "../src/XorrDelegation.sol";
import {MockUSDC} from "./XorrDelegation.t.sol";

/**
 * @dev Stands in for an aggregator's approval contract (OKX DEX's `0x8b77…F000` on X Layer): only the router may ask it to
 *      pull, and it pulls from whoever approved it.
 */
contract ApprovalProxy {
    address public router;

    function setRouter(address r) external {
        router = r;
    }

    function claim(MockUSDC token, address from, address to, uint256 amount) external {
        require(msg.sender == router, "only router");
        token.transferFrom(from, to, amount);
    }
}

/**
 * @dev A router that pulls its input through `ApprovalProxy` rather than for itself — so approving the ROUTER, as
 *      `spend` does, approves the wrong address.
 */
contract ProxiedRouter {
    ApprovalProxy public proxy;
    MockUSDC public input;
    MockUSDC public output;

    constructor(ApprovalProxy p, MockUSDC i, MockUSDC o) {
        proxy = p;
        input = i;
        output = o;
    }

    function swap(uint256 amountIn, address to, uint256 amountOut) external {
        proxy.claim(input, msg.sender, address(this), amountIn);
        output.mint(to, amountOut);
    }
}

contract XorrDelegationViaTest is Test {
    XorrDelegation internal del;
    MockUSDC internal usdc;
    MockUSDC internal asset;
    ApprovalProxy internal buyProxy;
    ProxiedRouter internal buyRouter;
    ApprovalProxy internal sellProxy;
    ProxiedRouter internal sellRouter;

    address internal owner = address(0xA11CE);
    address internal bot = address(0xB0B);

    uint256 internal constant USD = 1e6;
    uint256 internal constant DAILY_CAP = 100 * USD;

    function setUp() public {
        usdc = new MockUSDC();
        asset = new MockUSDC();
        del = new XorrDelegation(address(usdc));
        buyProxy = new ApprovalProxy();
        buyRouter = new ProxiedRouter(buyProxy, usdc, asset);
        buyProxy.setRouter(address(buyRouter));
        sellProxy = new ApprovalProxy();
        sellRouter = new ProxiedRouter(sellProxy, asset, usdc);
        sellProxy.setRouter(address(sellRouter));

        usdc.mint(owner, 1_000 * USD);
        address[] memory venues = new address[](4);
        venues[0] = address(buyRouter);
        venues[1] = address(buyProxy);
        venues[2] = address(sellRouter);
        venues[3] = address(sellProxy);

        vm.startPrank(owner);
        usdc.approve(address(del), type(uint256).max);
        asset.approve(address(del), type(uint256).max);
        del.grant(bot, DAILY_CAP, uint64(block.timestamp + 7 days), venues);
        vm.stopPrank();
    }

    function _pay(uint256 amountIn, uint256 amountOut) internal view returns (bytes memory) {
        return abi.encodeWithSelector(ProxiedRouter.swap.selector, amountIn, owner, amountOut);
    }

    function test_SpendViaFillsThroughTheApprovalContract() public {
        vm.prank(bot);
        del.spendVia(owner, address(usdc), address(buyProxy), address(buyRouter), 40 * USD, address(asset), 40 * USD, _pay(40 * USD, 40 * USD));
        assertEq(asset.balanceOf(owner), 40 * USD, "the owner received the output");
        assertEq(usdc.balanceOf(owner), 960 * USD, "exactly the amount was pulled");
        assertEq(del.spentToday(owner), 40 * USD, "and it counts against the day's cap");
        assertEq(usdc.allowance(address(del), address(buyProxy)), 0, "no standing approval is left behind");
        assertEq(usdc.balanceOf(address(del)), 0, "the contract holds nothing");
    }

    function test_PlainSpendCannotFillThroughASeparateSpender() public {
        // `spend` approves the router, but this router pulls through the proxy: the pull fails and so does the trade.
        vm.prank(bot);
        vm.expectRevert();
        del.spend(owner, address(usdc), address(buyRouter), 40 * USD, address(asset), 40 * USD, _pay(40 * USD, 40 * USD));
    }

    function test_SpendViaRefusesASpenderTheOwnerDidNotAllow() public {
        ApprovalProxy stranger = new ApprovalProxy();
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.VenueNotAllowed.selector, address(stranger)));
        del.spendVia(owner, address(usdc), address(stranger), address(buyRouter), 40 * USD, address(asset), 40 * USD, _pay(40 * USD, 40 * USD));
    }

    function test_SpendViaIsHeldToTheCapAndTheFloor() public {
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.DailyCapExceeded.selector, 150 * USD, DAILY_CAP));
        del.spendVia(owner, address(usdc), address(buyProxy), address(buyRouter), 150 * USD, address(asset), 1, _pay(150 * USD, 150 * USD));

        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.OutputNotReceived.selector, 10 * USD, 40 * USD));
        del.spendVia(owner, address(usdc), address(buyProxy), address(buyRouter), 40 * USD, address(asset), 40 * USD, _pay(40 * USD, 10 * USD));
    }

    function test_ClosePositionViaSellsBackThroughTheApprovalContract() public {
        asset.mint(owner, 30 * USD);
        vm.prank(bot);
        del.closePositionVia(owner, address(asset), address(sellProxy), address(sellRouter), 30 * USD, address(usdc), 30 * USD, _pay(30 * USD, 30 * USD));
        assertEq(asset.balanceOf(owner), 0, "the holding was sold");
        assertEq(usdc.balanceOf(owner), 1_030 * USD, "the proceeds reached the owner");
        assertEq(del.spentToday(owner), 0, "a close never spends the cap");
        assertEq(asset.allowance(address(del), address(sellProxy)), 0, "no standing approval is left behind");
    }

    function test_ViaRespectsRevocation() public {
        vm.prank(owner);
        del.revoke();
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyRevoked.selector);
        del.spendVia(owner, address(usdc), address(buyProxy), address(buyRouter), 40 * USD, address(asset), 40 * USD, _pay(40 * USD, 40 * USD));
    }
}
