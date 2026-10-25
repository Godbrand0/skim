// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MezoDeposit} from "../src/MezoDeposit.sol";
import {AccountChecks} from "./AccountChecks.sol";

/// @notice Deploys MezoDeposit on Base mainnet (chain 8453). Users deposit USDC here and receive mUSDC on Mezo
///         (the "enter" lane). The same contract that collects mUSDC on Mezo works unchanged.
///
/// Required env: ADMIN, GUARDIAN, TREASURY (the Base address that collects the USDC)
/// Optional env: ADMIN_DELAY_SECONDS [172800]
///
/// Dry run:    forge script script/DeployDepositBase.s.sol --rpc-url $BASE_RPC
/// Broadcast:  add --account <keystore> --broadcast
/// Afterwards the ADMIN enables USDC: TOKENS=usdc RPC_URL=$BASE_RPC ./scripts/configure-deposit.sh send
contract DeployDepositBase is Script {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (MezoDeposit dep) {
        require(block.chainid == 8453, "not Base mainnet");

        address admin = vm.envAddress("ADMIN");
        address guardian = vm.envAddress("GUARDIAN");
        address treasury = vm.envAddress("TREASURY");
        require(admin != address(0) && guardian != address(0) && treasury != address(0), "zero address");
        require(admin != guardian, "roles must differ");
        AccountChecks.requirePlain(admin, "ADMIN");
        AccountChecks.requirePlain(guardian, "GUARDIAN");
        AccountChecks.requirePlain(treasury, "TREASURY");

        uint48 delay = uint48(vm.envOr("ADMIN_DELAY_SECONDS", uint256(2 days)));
        require(IERC20Like(BASE_USDC).totalSupply() > 0, "USDC not found");
        if (admin.code.length == 0) console.log("WARNING: ADMIN is an EOA, use a multisig for mainnet");

        vm.startBroadcast();
        dep = new MezoDeposit(admin, delay, guardian, treasury);
        vm.stopBroadcast();

        console.log("MezoDeposit (USDC, on Base):", address(dep));
        console.log("The ADMIN must now enable USDC (see scripts/configure-deposit.sh).");
    }
}

interface IERC20Like {
    function totalSupply() external view returns (uint256);
}
