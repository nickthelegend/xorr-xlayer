// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XorrDelegation} from "../src/XorrDelegation.sol";
import {MockUSDC, MockVenue} from "./XorrDelegation.t.sol";

/**
 * Each agent's own budget, enforced by the contract.
 *
 * One delegate key trades for every agent; what stops one agent spending another's share, or more than the owner gave
 * it, is this ledger — charged on every agent trade, credited by every agent sale, and set only by the owner.
 */
contract XorrAgentBudgetTest is Test {
    XorrDelegation internal del;
    MockUSDC internal usdc;
    MockUSDC internal asset;
    MockVenue internal buyVenue;
    MockVenue internal sellVenue;

    address internal owner = address(0xA11CE);
    address internal other = address(0x0B0E);
    address internal bot = address(0xB0B);
    address internal attacker = address(0xBAD);

    uint256 internal constant USD = 1e6;
    uint256 internal constant DAILY_CAP = 100 * USD;

    bytes32 internal constant SCOUT = keccak256("xorr-agent:momentum-scout");
    bytes32 internal constant KEEPER = keccak256("xorr-agent:yield-keeper");

    function setUp() public {
        usdc = new MockUSDC();
        asset = new MockUSDC();
        del = new XorrDelegation(address(usdc));
        buyVenue = new MockVenue(usdc, asset, del);
        sellVenue = new MockVenue(asset, usdc, del);

        address[] memory venues = new address[](2);
        venues[0] = address(buyVenue);
        venues[1] = address(sellVenue);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? owner : other;
            usdc.mint(who, 10_000 * USD);
            vm.startPrank(who);
            usdc.approve(address(del), type(uint256).max);
            asset.approve(address(del), type(uint256).max);
            del.grant(bot, DAILY_CAP, uint64(block.timestamp + 7 days), venues);
            vm.stopPrank();
        }
    }

    function _pay(uint256 amountIn, address to, uint256 amountOut) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockVenue.swap.selector, amountIn, to, amountOut);
    }

    /// An agent's buy of `amount` USDC of `asset`, delivered 1:1 to `who`.
    function _agentBuy(address who, bytes32 agent, uint256 amount) internal {
        vm.prank(bot);
        del.spendForAgent(
            who, agent, address(usdc), address(buyVenue), address(buyVenue), amount, address(asset), amount, _pay(amount, who, amount)
        );
    }

    /// An agent's sale of `amount` of `asset`, returning `proceeds` USDC to `who`.
    function _agentSell(address who, bytes32 agent, uint256 amount, uint256 proceeds) internal {
        vm.prank(bot);
        del.closeForAgent(
            who, agent, address(asset), address(sellVenue), address(sellVenue), amount, address(usdc), proceeds, _pay(amount, who, proceeds)
        );
    }

    function _budget(address who, bytes32 agent, uint256 amount) internal {
        vm.prank(who);
        del.setAgentBudget(agent, amount);
    }

    // ── Setting a budget ─────────────────────────────────────────────────────

    function test_TheOwnerSetsABudgetInOneCall() public {
        vm.expectEmit(true, true, false, true, address(del));
        emit XorrDelegation.AgentBudgetSet(owner, SCOUT, 50 * USD);
        _budget(owner, SCOUT, 50 * USD);
        assertEq(del.agentBudget(owner, SCOUT), 50 * USD);
    }

    function test_TheZeroAgentCannotBeBudgeted() public {
        vm.prank(owner);
        vm.expectRevert(XorrDelegation.AgentRequired.selector);
        del.setAgentBudget(bytes32(0), 50 * USD);
    }

    /// Anyone can call it — and it only ever writes the caller's own budgets.
    function test_NobodyCanSetAnotherOwnersBudget() public {
        _budget(owner, SCOUT, 10 * USD);
        vm.prank(attacker);
        del.setAgentBudget(SCOUT, 1_000_000 * USD);
        assertEq(del.agentBudget(owner, SCOUT), 10 * USD, "an attacker raised the owner's budget");
        assertEq(del.agentBudget(attacker, SCOUT), 1_000_000 * USD);
    }

    // ── Spending ─────────────────────────────────────────────────────────────

    function test_AnAgentTradeIsChargedToItsBudgetAndTheDailyCap() public {
        _budget(owner, SCOUT, 50 * USD);
        vm.expectEmit(true, true, false, true, address(del));
        emit XorrDelegation.AgentSpent(owner, SCOUT, 20 * USD, 30 * USD);
        _agentBuy(owner, SCOUT, 20 * USD);

        assertEq(del.agentBudget(owner, SCOUT), 30 * USD, "the budget was not charged");
        assertEq(del.remainingToday(owner), 80 * USD, "the daily cap was not charged");
        assertEq(asset.balanceOf(owner), 20 * USD, "the output did not reach the owner");
        assertEq(usdc.balanceOf(address(del)), 0, "the contract kept something");
    }

    function test_AnAgentCannotSpendPastItsBudget() public {
        _budget(owner, SCOUT, 25 * USD);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.AgentBudgetExceeded.selector, SCOUT, 30 * USD, 25 * USD));
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 30 * USD, address(asset), 30 * USD, _pay(30 * USD, owner, 30 * USD)
        );
        assertEq(usdc.balanceOf(owner), 10_000 * USD, "money moved on a refused trade");
        assertEq(del.remainingToday(owner), DAILY_CAP, "a refused trade counted against the cap");
        assertEq(del.agentBudget(owner, SCOUT), 25 * USD, "a refused trade charged the budget");
    }

    function test_AnUnbudgetedAgentCannotSpendAtAll() public {
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.AgentBudgetExceeded.selector, SCOUT, 1 * USD, 0));
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 1 * USD, address(asset), 1 * USD, _pay(1 * USD, owner, 1 * USD)
        );
    }

    /// A budget bigger than the day's cap does not widen the day's cap.
    function test_TheDailyCapStillBindsAnAgentWithABigBudget() public {
        _budget(owner, SCOUT, 1_000 * USD);
        _agentBuy(owner, SCOUT, 90 * USD);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.DailyCapExceeded.selector, 20 * USD, 10 * USD));
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 20 * USD, address(asset), 20 * USD, _pay(20 * USD, owner, 20 * USD)
        );
        assertEq(del.agentBudget(owner, SCOUT), 910 * USD, "the refused trade charged the budget");
    }

    function test_OneAgentsSpendingDoesNotTouchAnothersBudget() public {
        _budget(owner, SCOUT, 30 * USD);
        _budget(owner, KEEPER, 40 * USD);
        _agentBuy(owner, SCOUT, 30 * USD);
        assertEq(del.agentBudget(owner, SCOUT), 0);
        assertEq(del.agentBudget(owner, KEEPER), 40 * USD, "the keeper paid for the scout");
    }

    function test_BudgetsBelongToTheirOwner() public {
        _budget(owner, SCOUT, 30 * USD);
        _budget(other, SCOUT, 30 * USD);
        _agentBuy(owner, SCOUT, 30 * USD);
        assertEq(del.agentBudget(other, SCOUT), 30 * USD, "one owner's agent spent another owner's budget");
    }

    function test_ZeroingABudgetStopsThatAgent() public {
        _budget(owner, SCOUT, 50 * USD);
        _budget(owner, SCOUT, 0);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.AgentBudgetExceeded.selector, SCOUT, 10 * USD, 0));
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    function test_AnAgentTradeMustNameAnAgent() public {
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.AgentRequired.selector);
        del.spendForAgent(
            owner, bytes32(0), address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    function test_OnlyTheDelegateCanTradeForAnAgent() public {
        _budget(owner, SCOUT, 50 * USD);
        vm.prank(attacker);
        vm.expectRevert(XorrDelegation.NotDelegate.selector);
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    function test_RevokeStopsEveryAgent() public {
        _budget(owner, SCOUT, 50 * USD);
        vm.prank(owner);
        del.revoke();
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyRevoked.selector);
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    function test_ExpiryStopsEveryAgent() public {
        _budget(owner, SCOUT, 50 * USD);
        vm.warp(block.timestamp + 8 days);
        vm.prank(bot);
        vm.expectRevert(XorrDelegation.PolicyExpired.selector);
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    function test_TheAgentsOutputMustStillReachTheOwner() public {
        _budget(owner, SCOUT, 50 * USD);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(XorrDelegation.OutputNotReceived.selector, 0, 10 * USD));
        del.spendForAgent(
            owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), 10 * USD, address(asset), 10 * USD, _pay(10 * USD, attacker, 10 * USD)
        );
        assertEq(del.agentBudget(owner, SCOUT), 50 * USD, "a reverted trade charged the budget");
    }

    // ── Selling ──────────────────────────────────────────────────────────────

    function test_AnAgentsSaleCreditsItsBudgetAndNotTheCap() public {
        _budget(owner, SCOUT, 50 * USD);
        _agentBuy(owner, SCOUT, 40 * USD);
        assertEq(del.agentBudget(owner, SCOUT), 10 * USD);

        vm.expectEmit(true, true, false, true, address(del));
        emit XorrDelegation.AgentCredited(owner, SCOUT, 42 * USD, 52 * USD);
        _agentSell(owner, SCOUT, 40 * USD, 42 * USD);

        assertEq(del.agentBudget(owner, SCOUT), 52 * USD, "the sale was not credited back");
        assertEq(del.remainingToday(owner), 60 * USD, "the sale moved the daily cap");
        assertEq(usdc.balanceOf(owner), 10_000 * USD - 40 * USD + 42 * USD, "the proceeds did not reach the owner");
    }

    function test_ASaleForNoAgentCreditsNobody() public {
        _budget(owner, SCOUT, 50 * USD);
        _agentBuy(owner, SCOUT, 40 * USD);
        vm.prank(bot);
        del.closePosition(owner, address(asset), address(sellVenue), 40 * USD, address(usdc), 40 * USD, _pay(40 * USD, owner, 40 * USD));
        assertEq(del.agentBudget(owner, SCOUT), 10 * USD, "a plain close credited an agent");
    }

    function test_OnlyTheDelegateCanSellForAnAgent() public {
        asset.mint(owner, 10 * USD);
        vm.prank(attacker);
        vm.expectRevert(XorrDelegation.NotDelegate.selector);
        del.closeForAgent(
            owner, SCOUT, address(asset), address(sellVenue), address(sellVenue), 10 * USD, address(usdc), 10 * USD, _pay(10 * USD, owner, 10 * USD)
        );
    }

    /// No sequence of agent buys, however split, commits more than the agent's budget.
    function testFuzz_AnAgentNeverSpendsPastItsBudget(uint256 budget, uint256 a, uint256 b) public {
        budget = bound(budget, 1, DAILY_CAP);
        a = bound(a, 1, DAILY_CAP);
        b = bound(b, 1, DAILY_CAP);
        _budget(owner, SCOUT, budget);
        uint256 spent;
        for (uint256 i = 0; i < 2; i++) {
            uint256 amount = i == 0 ? a : b;
            vm.prank(bot);
            try del.spendForAgent(
                owner, SCOUT, address(usdc), address(buyVenue), address(buyVenue), amount, address(asset), amount, _pay(amount, owner, amount)
            ) {
                spent += amount;
            } catch {}
        }
        assertLe(spent, budget, "the agent spent past its budget");
        assertEq(del.agentBudget(owner, SCOUT), budget - spent);
    }
}
