// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFloat} from "../../src/MezoFloat.sol";

/// @notice Runs MezoFloat against the real Circle USDC on Base mainnet.
/// Run with: BASE_RPC_URL=https://mainnet.base.org forge test --match-path "test/fork/*"
/// Skipped when BASE_RPC_URL is not set.
contract MezoFloatForkTest is Test {
    IERC20 constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);

    MezoFloat vault;
    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        vault = new MezoFloat(USDC, admin, 2 days, relayer, guardian, 25e6, 50e6, 300e6);
        deal(address(USDC), address(vault), 300e6);
    }

    function test_fork_release_real_usdc() public {
        assertEq(vault.floatBalance(), 300e6);
        vm.prank(relayer);
        vault.release(alice, 2e6, bytes32("fork-1"));
        assertEq(USDC.balanceOf(alice), 2e6);
        assertEq(vault.floatBalance(), 298e6);
    }

    function test_fork_admin_can_recover_float() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(admin);
        vault.withdraw(admin, 300e6);
        assertEq(USDC.balanceOf(admin), 300e6);
        assertEq(vault.floatBalance(), 0);
    }

    function test_fork_usdc_is_the_expected_token() public view {
        // guards against a wrong constant slipping into the deploy script
        (bool ok, bytes memory data) = address(USDC).staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(abi.decode(data, (uint8)), 6);
    }
}
