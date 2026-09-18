// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @notice A stand-in venue for the Base Sepolia end-to-end test.
 *
 * 1inch does not deploy its aggregation router to Base Sepolia, so a real swap cannot be executed
 * there. This proves the half that testnet CAN prove: the executor signs, the delegation contract
 * enforces its limits, pulls the token and forwards the call to an allowlisted venue.
 *
 * The other half — real 1inch routing and calldata — is proven against the live Base mainnet API
 * in server/src/venues/oneinch.live.test.ts. The two meet on mainnet.
 */
contract TestVenue {
    address public immutable token;
    uint256 public totalReceived;

    event Filled(address indexed from, uint256 amountIn, uint256 unitsOut);

    constructor(address token_) {
        token = token_;
    }

    /// @param amount Amount of `token` to pull from the caller (the delegation contract).
    function swap(uint256 amount) external {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "pull failed");
        totalReceived += amount;
        emit Filled(msg.sender, amount, amount);
    }
}
