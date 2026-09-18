// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title XorrAuditAnchor
 * @notice Publishes the head of an off-chain hash chain to Base, so its integrity stops being
 *         something we assert and becomes something anyone can check.
 *
 * WHY THIS EXISTS
 *
 * `audit_log` is append-only by trigger and every row commits to its predecessor's hash, so
 * editing history breaks the chain and `/verify` reports it. That is a real property, and it has
 * one real limit: every part of it lives in our database. A reader who does not trust the operator
 * has no reason to trust the operator's own report that the operator's own log is intact. The
 * trail could be rewritten wholesale — new rows, new hashes, a clean chain — and nothing outside
 * would know.
 *
 * An anchor removes that. The head hash is written to Base at a known block. Rewriting history
 * afterwards is still possible, but producing a rewrite that hashes to a value Base has been
 * holding since before the rewrite is not. The guarantee moves from "we say so" to "the chain has
 * held this since block N, go and look".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not decide who is allowed to anchor, and it does not adjudicate between anchorers. Any
 * address may publish anchors for any subject, and every anchor records who published it. That is
 * the honest design for a public log: an anchor is a claim by a named party at a known time, and
 * its weight comes entirely from who made it. A permissioned version would only move the trust
 * question one step, to whoever holds the permission.
 *
 * So a verifier does not ask "is this anchored?" — it asks "what did THIS address publish, and
 * when?". `/verify` reads the anchors published by the executor's own delegate key, which is the
 * same address the app names on screen as the bot's key. A third party can read them without our
 * cooperation, from the chain, with the address alone.
 *
 * Anchors are append-only here too. There is no update and no delete; a later anchor does not
 * replace an earlier one, it follows it. A chain of anchors is a chain of commitments, and the
 * ability to withdraw one would defeat the point of making it.
 */
contract XorrAuditAnchor {
    /**
     * @param head       The hash of the last entry in the chain at the moment of anchoring.
     * @param entryCount How many entries the chain held. Monotonic for an append-only log, so a
     *                   later anchor with a LOWER count is visible evidence of truncation.
     * @param at         Block timestamp, recorded so a reader need not fetch the block.
     * @param blockNo    Block number, which is what "since block N" means to a verifier.
     */
    struct Anchor {
        bytes32 head;
        uint64 entryCount;
        uint64 at;
        uint64 blockNo;
    }

    /// anchorer => subject => anchors, oldest first. Append-only.
    mapping(address => mapping(address => Anchor[])) private _anchors;

    /**
     * @notice Emitted for every anchor. Indexed on both parties so a verifier can find every
     *         commitment a given key has ever made about a given subject with one log query, and
     *         does not have to trust an RPC's view of contract storage to do it.
     */
    event Anchored(
        address indexed anchorer,
        address indexed subject,
        bytes32 head,
        uint64 entryCount,
        uint64 blockNo
    );

    error EmptyHead();
    error CountWentBackwards(uint64 previous, uint64 attempted);

    /**
     * @notice Publish the current head of `subject`'s trail.
     * @dev Reverts on a zero head, because a zero hash is what an uninitialised read returns and
     *      an anchor indistinguishable from "no anchor" is worse than none.
     *
     *      Also reverts when the count moves backwards. The log it describes is append-only, so a
     *      shrinking count is either a bug on our side or an attempt to anchor a truncated trail;
     *      refusing it on-chain means the failure surfaces at the moment it is attempted rather
     *      than being discovered later by someone reading the history. It does NOT prevent
     *      anchoring a rewritten trail of equal or greater length — nothing on-chain could — which
     *      is exactly why the timestamp is the part that carries the weight.
     */
    function anchor(address subject, bytes32 head, uint64 entryCount) external {
        if (head == bytes32(0)) revert EmptyHead();

        Anchor[] storage series = _anchors[msg.sender][subject];
        if (series.length != 0) {
            uint64 previous = series[series.length - 1].entryCount;
            if (entryCount < previous) revert CountWentBackwards(previous, entryCount);
        }

        series.push(
            Anchor({
                head: head,
                entryCount: entryCount,
                at: uint64(block.timestamp),
                blockNo: uint64(block.number)
            })
        );

        emit Anchored(msg.sender, subject, head, entryCount, uint64(block.number));
    }

    /// @notice How many anchors `anchorer` has published about `subject`.
    function count(address anchorer, address subject) external view returns (uint256) {
        return _anchors[anchorer][subject].length;
    }

    /**
     * @notice The most recent anchor, or a zero struct when there is none.
     * @dev Returning a zero struct rather than reverting keeps the caller's branch simple, and
     *      `head == 0` is unambiguous because `anchor()` refuses to write a zero head.
     */
    function latest(address anchorer, address subject) external view returns (Anchor memory) {
        Anchor[] storage series = _anchors[anchorer][subject];
        if (series.length == 0) return Anchor(bytes32(0), 0, 0, 0);
        return series[series.length - 1];
    }

    /// @notice One anchor by position, oldest first.
    function at(address anchorer, address subject, uint256 index) external view returns (Anchor memory) {
        return _anchors[anchorer][subject][index];
    }

    /**
     * @notice The whole series, oldest first.
     * @dev Unbounded by design: anchoring is deliberately infrequent, and a verifier reading the
     *      full history of commitments is the intended use rather than an edge case. Callers that
     *      cannot afford an unbounded read have `count` and `at`.
     */
    function history(address anchorer, address subject) external view returns (Anchor[] memory) {
        return _anchors[anchorer][subject];
    }
}
