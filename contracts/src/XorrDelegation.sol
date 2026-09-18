// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface. The full interface is not needed and not imported.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title XorrDelegation
 * @notice The permission that lets a bot trade a user's capital while they are not looking.
 *
 * The product promise (screen 20 of the design handoff) is that the bot's authority is
 * TRADE-ONLY, VENUE-ALLOWLISTED, CAPPED PER DAY, TIME-BOXED, and REVOCABLE IN ONE TAP.
 *
 * The previous Solana build used SPL token delegation, which enforced scope, a total cap and
 * revocation at the token program — but the DAILY boundary and the venue allowlist still lived in
 * the executor. That was a documented residual risk: an executor compromise could spend the whole
 * remaining allowance in one go.
 *
 * This contract closes that. Every constraint is enforced here:
 *   - the daily cap resets on a UTC day boundary and is checked on-chain,
 *   - the expiry is checked on-chain,
 *   - the venue must be on the owner's allowlist,
 *   - the delegate can move funds to an ALLOWLISTED VENUE ONLY, never to an address it chooses,
 *   - revoke() takes effect immediately and needs nothing but the owner's signature.
 *
 * The contract never holds user funds. It pulls exactly the approved amount from the owner at the
 * moment of a trade and forwards it to the venue, so a user's balance sits in their own wallet
 * right up until a trade executes.
 *
 * WHERE THE OUTPUT GOES (PLAN.md 1.4)
 *
 * "Allowlisted venue only" was true and was not enough: an allowlisted venue pays whoever its
 * calldata names. The 1inch router takes a receiver, our own books took a `principal`, and the
 * delegate chose both — so a leaked delegate key could spend an owner's day of cap and have the
 * proceeds delivered to itself. Three rules close that:
 *   - every trade names the token it should produce and a floor, and the OWNER's balance of that
 *     token must rise by at least the floor across the venue call, or the whole trade reverts;
 *   - the owner a venue call is made for is recorded, in transient storage, for exactly the length
 *     of that call (`activeOwner`), so a venue that pays out — our books — refuses any other recipient;
 *   - closing refuses the settlement token, so a close cannot move the asset the cap exists to limit.
 *
 * What this does not claim: the floor is chosen by the delegate. A route that pays the owner the
 * floor and sends the rest elsewhere would satisfy it; that residue is bounded by the daily cap, the
 * venue allowlist and the kill switch, not by this check. The executor sets the floor from a live
 * quote less the slippage limit, so an honest floor is nearly the whole trade.
 */
contract XorrDelegation {
    struct Policy {
        address delegate;
        uint256 dailyCap;
        uint64 expiresAt;
        bool revoked;
    }

    /// @notice What the daily cap is denominated in, and therefore what `closePosition` will not sell.
    address public immutable SETTLEMENT_TOKEN;

    /// @dev owner => policy
    mapping(address => Policy) private _policies;
    /// @dev owner => UTC day index => amount spent that day
    mapping(address => mapping(uint256 => uint256)) private _spentOnDay;
    /// @dev owner => venue => allowed
    mapping(address => mapping(address => bool)) private _venueAllowed;
    /**
     * @dev owner => every venue allowed since the last grant, so a grant can start the list over.
     *
     * The mapping above cannot be enumerated, so a re-grant used to ADD to whatever had been allowed
     * before: a venue dropped from the app's list stayed allowed on chain forever, invisible to the
     * user who thought they had removed it. Only the owner's own calls grow this.
     */
    mapping(address => address[]) private _venueList;

    /// @dev EIP-1153 slot holding the owner the current venue call is being made for.
    bytes32 private constant ACTIVE_OWNER_SLOT = keccak256("xorr.delegation.activeOwner");

    event Granted(
        address indexed owner,
        address indexed delegate,
        uint256 dailyCap,
        uint64 expiresAt
    );
    event Revoked(address indexed owner, address indexed delegate);
    event VenueAllowed(address indexed owner, address indexed venue, bool allowed);
    /// @notice A position was closed. Deliberately a different event from `Spent`: one is the bot
    ///         committing the user's money, the other is it taking risk off, and a history that
    ///         cannot tell them apart is not much of a history.
    event Closed(
        address indexed owner,
        address indexed delegate,
        address indexed venue,
        address token,
        uint256 amount
    );

    event Spent(
        address indexed owner,
        address indexed delegate,
        address indexed venue,
        address token,
        uint256 amount,
        uint256 spentToday
    );

    error NotDelegate();
    error PolicyRevoked();
    error PolicyExpired();
    error VenueNotAllowed(address venue);
    error DailyCapExceeded(uint256 requested, uint256 remaining);
    error ZeroAmount();
    error VenueCallFailed();
    /// @notice The trade did not name a real output token distinct from what it sells.
    error InvalidTokenOut();
    /// @notice A floor of zero would let a trade deliver nothing to the owner and still succeed.
    error ZeroMinOut();
    /// @notice The owner's balance of the output token rose by less than the floor.
    error OutputNotReceived(uint256 received, uint256 minOut);
    /// @notice Closing is not capped, so it may not be used to move the asset the cap limits.
    error SettlementTokenNotClosable();

    constructor(address settlementToken) {
        require(settlementToken != address(0), "settlement token required");
        SETTLEMENT_TOKEN = settlementToken;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owner actions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Grant the bot a capped, time-boxed, venue-scoped trading authority.
     * @dev Re-granting REPLACES the policy, venues included, which is how the app's "Save Settings"
     *      works: a venue left off the new list is no longer allowed. The owner must also ERC-20
     *      approve this contract for the tokens it may pull.
     */
    function grant(
        address delegate,
        uint256 dailyCap,
        uint64 expiresAt,
        address[] calldata venues
    ) external {
        require(delegate != address(0), "delegate required");
        require(dailyCap > 0, "cap required");
        require(expiresAt > block.timestamp, "expiry in the past");

        _policies[msg.sender] = Policy({
            delegate: delegate,
            dailyCap: dailyCap,
            expiresAt: expiresAt,
            revoked: false
        });

        address[] storage listed = _venueList[msg.sender];
        for (uint256 i = 0; i < listed.length; i++) {
            if (_venueAllowed[msg.sender][listed[i]]) {
                _venueAllowed[msg.sender][listed[i]] = false;
                emit VenueAllowed(msg.sender, listed[i], false);
            }
        }
        delete _venueList[msg.sender];

        for (uint256 i = 0; i < venues.length; i++) {
            _setVenue(msg.sender, venues[i], true);
        }

        emit Granted(msg.sender, delegate, dailyCap, expiresAt);
    }

    /**
     * @notice The kill switch. Takes effect immediately, on-chain.
     * @dev Deliberately needs nothing but the owner's signature — no server, no oracle, no
     *      cooperation from the bot. This is what makes "takes effect in under a second across
     *      every device" true by construction rather than by infrastructure.
     */
    function revoke() external {
        Policy storage p = _policies[msg.sender];
        address delegate = p.delegate;
        p.revoked = true;
        emit Revoked(msg.sender, delegate);
    }

    function setVenue(address venue, bool allowed) external {
        _setVenue(msg.sender, venue, allowed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Delegate action — the only thing the bot's key can do
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Spend the owner's capital at an allowlisted venue, inside the daily cap.
     * @dev Order matters: every check runs BEFORE any value moves, so a rejected trade leaves
     *      the owner's balance and their spent-today total completely untouched.
     * @param owner The user whose policy authorises this.
     * @param token The ERC-20 being spent.
     * @param venue The allowlisted contract to trade against.
     * @param amount Amount of `token` to spend.
     * @param tokenOut The token the trade must deliver to the owner.
     * @param minOut The least the owner's `tokenOut` balance must rise by. Must be above zero.
     * @param data Calldata forwarded to `venue` (e.g. a Uniswap v3 `exactInput` payload).
     */
    function spend(
        address owner,
        address token,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) external returns (bytes memory result) {
        return _spend(owner, token, venue, venue, amount, tokenOut, minOut, data);
    }

    /**
     * @notice `spend` through a venue that pulls tokens via a separate approval contract.
     *
     * @dev Some aggregators (OKX DEX) call a router that has the input pulled by a different contract, so approving the
     *      call target — what `spend` does — approves the wrong address and the trade reverts. Here the `spender` is
     *      approved (for exactly `amount`, reset to zero after) and `venue` is called. BOTH must be on the owner's
     *      allowlist: the owner signs for every address that may touch their tokens, and the cap, expiry, revocation and
     *      output floor apply exactly as in `spend`.
     * @param spender The allowlisted address the venue pulls `token` through.
     */
    function spendVia(
        address owner,
        address token,
        address spender,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) external returns (bytes memory result) {
        return _spend(owner, token, spender, venue, amount, tokenOut, minOut, data);
    }

    function _spend(
        address owner,
        address token,
        address spender,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) private returns (bytes memory result) {
        Policy memory p = _policies[owner];

        if (msg.sender != p.delegate) revert NotDelegate();
        if (p.revoked) revert PolicyRevoked();
        if (block.timestamp >= p.expiresAt) revert PolicyExpired();
        if (!_venueAllowed[owner][venue]) revert VenueNotAllowed(venue);
        if (!_venueAllowed[owner][spender]) revert VenueNotAllowed(spender);
        if (amount == 0) revert ZeroAmount();
        _requireNamedOutput(token, tokenOut, minOut);

        uint256 day = _dayOf(block.timestamp);
        uint256 spent = _spentOnDay[owner][day];
        uint256 remaining = p.dailyCap > spent ? p.dailyCap - spent : 0;
        if (amount > remaining) revert DailyCapExceeded(amount, remaining);

        // Effects before interactions.
        _spentOnDay[owner][day] = spent + amount;

        // Pull exactly `amount` from the owner. The contract holds nothing between trades.
        require(IERC20(token).transferFrom(owner, address(this), amount), "pull failed");
        result = _callVenue(owner, token, spender, venue, amount, tokenOut, minOut, data);

        emit Spent(owner, p.delegate, venue, token, amount, spent + amount);
    }

    /**
     * @notice Close a position: sell an asset the owner holds, back to the settlement token.
     *
     * @dev Why this is not `spend`.
     *
     * The daily cap is denominated in the settlement token's units, because it is a limit on how
     * much of the user's money the bot may COMMIT. Routing a sell through `spend` was wrong twice
     * over: the amount would be 0.3e18 wei of WETH measured against a cap of 2000e6 USDC units,
     * which is nonsense arithmetic, and a stop-loss would stop working the moment the day's
     * spending cap was used up. A stop that a spending limit can silence is not a stop.
     *
     * So closing is separately authorised and separately bounded:
     *   - same delegate, same expiry, same revocation flag, same venue allowlist
     *   - the proceeds MUST reach the owner: the owner's `tokenOut` balance has to rise by `minOut`
     *   - it does not touch the daily cap in either direction, because de-risking is not spending
     *   - it cannot sell the settlement token itself — an uncapped way to move the capped asset
     *     would make the cap decorative
     *
     * The asymmetry is deliberate and is the same asymmetry as the ladder: a permission that can
     * only reduce exposure is safe to grant more freely than one that can add to it.
     *
     * @param owner The user whose policy authorises this.
     * @param token The asset being sold. Must not be the settlement token.
     * @param venue The allowlisted contract to trade against.
     * @param amount Amount of `token` to sell, in that token's own units.
     * @param tokenOut The token the sale must deliver to the owner.
     * @param minOut The least the owner's `tokenOut` balance must rise by. Must be above zero.
     * @param data Calldata forwarded to `venue`.
     */
    function closePosition(
        address owner,
        address token,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) external returns (bytes memory result) {
        return _close(owner, token, venue, venue, amount, tokenOut, minOut, data);
    }

    /// @notice `closePosition` through a venue that pulls via a separate, allowlisted approval contract. See `spendVia`.
    function closePositionVia(
        address owner,
        address token,
        address spender,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) external returns (bytes memory result) {
        return _close(owner, token, spender, venue, amount, tokenOut, minOut, data);
    }

    function _close(
        address owner,
        address token,
        address spender,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) private returns (bytes memory result) {
        Policy memory p = _policies[owner];

        if (msg.sender != p.delegate) revert NotDelegate();
        if (p.revoked) revert PolicyRevoked();
        if (block.timestamp >= p.expiresAt) revert PolicyExpired();
        if (!_venueAllowed[owner][venue]) revert VenueNotAllowed(venue);
        if (!_venueAllowed[owner][spender]) revert VenueNotAllowed(spender);
        if (amount == 0) revert ZeroAmount();
        if (token == SETTLEMENT_TOKEN) revert SettlementTokenNotClosable();
        _requireNamedOutput(token, tokenOut, minOut);

        require(IERC20(token).transferFrom(owner, address(this), amount), "pull failed");
        result = _callVenue(owner, token, spender, venue, amount, tokenOut, minOut, data);

        emit Closed(owner, p.delegate, venue, token, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views — the app reads its own limits from the chain, never from our database
    // ─────────────────────────────────────────────────────────────────────────

    function policyOf(address owner)
        external
        view
        returns (address delegate, uint256 dailyCap, uint64 expiresAt, bool revoked)
    {
        Policy memory p = _policies[owner];
        return (p.delegate, p.dailyCap, p.expiresAt, p.revoked);
    }

    /// @notice What the bot may still spend today. The number the Safety screen shows.
    function remainingToday(address owner) external view returns (uint256) {
        Policy memory p = _policies[owner];
        if (p.revoked || block.timestamp >= p.expiresAt) return 0;
        uint256 spent = _spentOnDay[owner][_dayOf(block.timestamp)];
        return p.dailyCap > spent ? p.dailyCap - spent : 0;
    }

    function spentToday(address owner) external view returns (uint256) {
        return _spentOnDay[owner][_dayOf(block.timestamp)];
    }

    function isVenueAllowed(address owner, address venue) external view returns (bool) {
        return _venueAllowed[owner][venue];
    }

    /**
     * @notice The owner whose trade is executing right now, or zero outside one.
     * @dev Set immediately before a venue call and cleared immediately after, in transient storage,
     *      so it can never outlive the transaction. A venue that pays out reads it to refuse any
     *      recipient other than the owner — see `XorrAquaBook` and `XorrSwapVMBook`.
     */
    function activeOwner() public view returns (address owner) {
        bytes32 slot = ACTIVE_OWNER_SLOT;
        assembly {
            owner := tload(slot)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _setVenue(address owner, address venue, bool allowed) private {
        if (allowed && !_venueAllowed[owner][venue]) _venueList[owner].push(venue);
        _venueAllowed[owner][venue] = allowed;
        emit VenueAllowed(owner, venue, allowed);
    }

    function _requireNamedOutput(address token, address tokenOut, uint256 minOut) private pure {
        if (tokenOut == address(0) || tokenOut == token) revert InvalidTokenOut();
        if (minOut == 0) revert ZeroMinOut();
    }

    /**
     * @dev Approve `spender` (the venue itself, or the venue's approval contract) for exactly `amount`, call the venue
     *      with the owner recorded as active, take the approval back, and require the owner to have received at least
     *      `minOut` of `tokenOut`.
     */
    function _callVenue(
        address owner,
        address token,
        address spender,
        address venue,
        uint256 amount,
        address tokenOut,
        uint256 minOut,
        bytes calldata data
    ) private returns (bytes memory ret) {
        // Approve the spender for exactly this trade, and nothing more.
        IERC20(token).approve(spender, amount);
        uint256 before = IERC20(tokenOut).balanceOf(owner);

        _setActiveOwner(owner);
        bool ok;
        (ok, ret) = venue.call(data);
        _setActiveOwner(address(0));
        _bubble(ok, ret);

        // Never leave a standing approval behind.
        IERC20(token).approve(spender, 0);

        uint256 afterCall = IERC20(tokenOut).balanceOf(owner);
        uint256 received = afterCall > before ? afterCall - before : 0;
        if (received < minOut) revert OutputNotReceived(received, minOut);
    }

    function _setActiveOwner(address owner) private {
        bytes32 slot = ACTIVE_OWNER_SLOT;
        assembly {
            tstore(slot, owner)
        }
    }

    /// @dev UTC day index. The cap resets at midnight UTC, which is what the app tells the user.
    function _dayOf(uint256 timestamp) private pure returns (uint256) {
        return timestamp / 1 days;
    }

    /**
     * @dev Re-throw the venue's own revert instead of replacing it.
     *
     * `revert VenueCallFailed()` threw away everything the venue said. A 1inch fill that failed
     * because the price moved past the slippage limit, one that failed because a pool was empty,
     * and one that failed because the calldata was malformed all reached the user as the same
     * sentence: "the venue rejected the order". That is the same class of unhelpfulness as
     * "custom program error: 0x1", and this codebase already decided that is not acceptable.
     *
     * So: if the venue reverted with data, bubble it up byte for byte. The executor can then
     * decode `ReturnAmountIsNotEnough` and say "the price moved more than your slippage limit",
     * which is both true and actionable. Only a silent revert — no data at all — falls back to
     * the named error, because there is nothing else to say.
     */
    function _bubble(bool ok, bytes memory ret) private pure {
        if (ok) return;
        if (ret.length == 0) revert VenueCallFailed();
        assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
