// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {XorrAuditAnchor} from "../src/XorrAuditAnchor.sol";

/// @notice Deploys XorrAuditAnchor. Target chain comes from --rpc-url.
contract DeployAnchor is Script {
    function run() external returns (XorrAuditAnchor anchorContract) {
        vm.startBroadcast();
        anchorContract = new XorrAuditAnchor();
        vm.stopBroadcast();
        console.log("XorrAuditAnchor deployed to:", address(anchorContract));
    }
}
