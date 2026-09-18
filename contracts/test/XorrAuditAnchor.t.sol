// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {XorrAuditAnchor} from "../src/XorrAuditAnchor.sol";

/**
 * The properties an anchor has to have to be worth anything:
 * it is attributable, it is append-only, it cannot be silently emptied, and it cannot be used to
 * quietly commit to a SHORTER trail than the one already committed to.
 */
contract XorrAuditAnchorTest is Test {
    XorrAuditAnchor internal anchorContract;

    address internal constant EXECUTOR = address(0xE0);
    address internal constant IMPOSTOR = address(0x1D);
    address internal constant SUBJECT = address(0x5B);

    bytes32 internal constant HEAD_A = keccak256("entry-10");
    bytes32 internal constant HEAD_B = keccak256("entry-20");

    function setUp() public {
        anchorContract = new XorrAuditAnchor();
    }

    function test_recordsHeadCountAndBlock() public {
        vm.roll(1_234);
        vm.warp(1_700_000_000);
        vm.prank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 10);

        XorrAuditAnchor.Anchor memory a = anchorContract.latest(EXECUTOR, SUBJECT);
        assertEq(a.head, HEAD_A);
        assertEq(a.entryCount, 10);
        assertEq(a.blockNo, 1_234);
        assertEq(a.at, 1_700_000_000);
    }

    /// The whole design: an anchor is a claim by a NAMED party. Two parties do not share a series.
    function test_anchorsAreScopedToWhoPublishedThem() public {
        vm.prank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 10);
        vm.prank(IMPOSTOR);
        anchorContract.anchor(SUBJECT, HEAD_B, 99);

        assertEq(anchorContract.latest(EXECUTOR, SUBJECT).head, HEAD_A, "executor's claim was overwritten");
        assertEq(anchorContract.latest(IMPOSTOR, SUBJECT).head, HEAD_B);
        assertEq(anchorContract.count(EXECUTOR, SUBJECT), 1);
        assertEq(anchorContract.count(IMPOSTOR, SUBJECT), 1);
    }

    /// A later anchor follows an earlier one. It never replaces it.
    function test_historyIsAppendOnly() public {
        vm.startPrank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 10);
        anchorContract.anchor(SUBJECT, HEAD_B, 20);
        vm.stopPrank();

        XorrAuditAnchor.Anchor[] memory all = anchorContract.history(EXECUTOR, SUBJECT);
        assertEq(all.length, 2);
        assertEq(all[0].head, HEAD_A, "the first commitment must still be readable");
        assertEq(all[1].head, HEAD_B);
    }

    /// A zero head reads identically to "never anchored", so it must not be writable.
    function test_refusesAnEmptyHead() public {
        vm.prank(EXECUTOR);
        vm.expectRevert(XorrAuditAnchor.EmptyHead.selector);
        anchorContract.anchor(SUBJECT, bytes32(0), 10);
    }

    /// Anchoring a truncated trail is refused where it happens, not discovered later.
    function test_refusesToCommitToAShorterTrail() public {
        vm.startPrank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 20);
        vm.expectRevert(abi.encodeWithSelector(XorrAuditAnchor.CountWentBackwards.selector, 20, 19));
        anchorContract.anchor(SUBJECT, HEAD_B, 19);
        vm.stopPrank();
    }

    /// Re-anchoring an unchanged trail is legitimate — it is a fresh timestamp on the same claim.
    function test_allowsRepeatingTheSameCount() public {
        vm.startPrank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 20);
        anchorContract.anchor(SUBJECT, HEAD_A, 20);
        vm.stopPrank();
        assertEq(anchorContract.count(EXECUTOR, SUBJECT), 2);
    }

    function test_latestIsZeroBeforeAnythingIsAnchored() public view {
        XorrAuditAnchor.Anchor memory a = anchorContract.latest(EXECUTOR, SUBJECT);
        assertEq(a.head, bytes32(0));
        assertEq(a.entryCount, 0);
    }

    function test_emitsAnchoredForOffChainVerifiers() public {
        vm.roll(555);
        vm.expectEmit(true, true, false, true);
        emit XorrAuditAnchor.Anchored(EXECUTOR, SUBJECT, HEAD_A, 10, 555);
        vm.prank(EXECUTOR);
        anchorContract.anchor(SUBJECT, HEAD_A, 10);
    }
}
