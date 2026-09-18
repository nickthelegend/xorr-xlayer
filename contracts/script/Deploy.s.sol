// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {XorrDelegation} from "../src/XorrDelegation.sol";

/**
 * @notice Deploys XorrDelegation. Target chain comes from --rpc-url.
 * @dev The settlement token comes from SETTLEMENT_TOKEN because it differs per chain — Circle's USDC
 *      is at one address on X Layer and another on its testnet — and it is immutable once deployed, so
 *      a token with no code at the given address is refused here rather than discovered later.
 */
contract Deploy is Script {
    function run() external returns (XorrDelegation delegation) {
        address settlement = vm.envAddress("SETTLEMENT_TOKEN");
        require(settlement.code.length > 0, "SETTLEMENT_TOKEN has no code on this chain");
        // DEPLOYER_PRIVATE_KEY from the environment (server/.env.deployer) keeps the key off the command line.
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        delegation = new XorrDelegation(settlement);
        vm.stopBroadcast();
        console.log("XorrDelegation deployed to:", address(delegation));
        console.log("settlement token:", settlement);
    }
}
