// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {XorrAuditAnchor} from "../src/XorrAuditAnchor.sol";

/// @notice Deploys XorrAuditAnchor. Target chain comes from --rpc-url.
contract DeployAnchor is Script {
    function run() external returns (XorrAuditAnchor anchorContract) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        anchorContract = new XorrAuditAnchor();
        vm.stopBroadcast();
        console.log("XorrAuditAnchor deployed to:", address(anchorContract));
    }
}
