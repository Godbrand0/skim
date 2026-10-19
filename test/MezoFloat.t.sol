// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MezoFloat} from "../src/MezoFloat.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MezoFloatTest is Test {
    uint256 constant USDC = 1e6;
    uint48 constant ADMIN_DELAY = 2 days;

    MockUSDC usdc;
    MezoFloat vault;

    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant MAX_TX = 20 * USDC;
    uint256 constant MAX_ADDR = 40 * USDC;
    uint256 constant MAX_DAY = 200 * USDC;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        vault = new MezoFloat(IERC20(address(usdc)), admin, ADMIN_DELAY, relayer, guardian, MAX_TX, MAX_ADDR, MAX_DAY);
        usdc.mint(address(vault), 300 * USDC);
    }

    // --- release ---------------------------------------------------------

    function test_release_pays_and_records() public {
        vm.prank(relayer);
        vault.release(alice, 2 * USDC, bytes32("r1"));

        assertEq(usdc.balanceOf(alice), 2 * USDC);
        assertEq(vault.floatBalance(), 298 * USDC);
        assertTrue(vault.refUsed(bytes32("r1")));
        assertEq(vault.globalSpentToday(), 2 * USDC);
        assertEq(vault.addressSpentToday(alice), 2 * USDC);
    }

    function test_release_emits_event() public {
        vm.expectEmit(true, true, false, true);
        emit MezoFloat.Released(bytes32("r1"), alice, 5 * USDC);
        vm.prank(relayer);
        vault.release(alice, 5 * USDC, bytes32("r1"));
    }

    function test_release_reverts_on_replay() public {
        vm.startPrank(relayer);
        vault.release(alice, USDC, bytes32("r1"));
        vm.expectRevert(abi.encodeWithSelector(MezoFloat.RefAlreadyUsed.selector, bytes32("r1")));
        vault.release(bob, USDC, bytes32("r1"));
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), 0);
    }

    function test_release_only_relayer() public {
        bytes32 role = vault.RELAYER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        vault.release(alice, USDC, bytes32("r1"));

        // admin and guardian cannot release either
        vm.prank(admin);
        vm.expectRevert();
        vault.release(alice, USDC, bytes32("r2"));
        vm.prank(guardian);
        vm.expectRevert();
        vault.release(alice, USDC, bytes32("r3"));
    }

    function test_release_rejects_bad_inputs() public {
        vm.startPrank(relayer);
        vm.expectRevert(MezoFloat.InvalidRecipient.selector);
        vault.release(address(0), USDC, bytes32("a"));
        vm.expectRevert(MezoFloat.InvalidRecipient.selector);
        vault.release(address(vault), USDC, bytes32("b"));
        vm.expectRevert(MezoFloat.ZeroAmount.selector);
        vault.release(alice, 0, bytes32("c"));
        vm.stopPrank();
    }

    function test_release_per_tx_limit() public {
        vm.startPrank(relayer);
        vault.release(alice, MAX_TX, bytes32("ok"));
        vm.expectRevert(abi.encodeWithSelector(MezoFloat.ExceedsPerTxLimit.selector, MAX_TX + 1, MAX_TX));
        vault.release(bob, MAX_TX + 1, bytes32("big"));
        vm.stopPrank();
    }

    function test_release_address_daily_limit_and_rollover() public {
        vm.startPrank(relayer);
        vault.release(alice, 20 * USDC, bytes32("1"));
        vault.release(alice, 20 * USDC, bytes32("2"));
        vm.expectRevert(abi.encodeWithSelector(MezoFloat.ExceedsAddressDailyLimit.selector, 41 * USDC, MAX_ADDR));
        vault.release(alice, USDC, bytes32("3"));

        // bob is unaffected
        vault.release(bob, 20 * USDC, bytes32("4"));

        // next UTC day resets the window
        vm.warp(block.timestamp + 1 days);
        vault.release(alice, 20 * USDC, bytes32("5"));
        vm.stopPrank();
        assertEq(vault.addressSpentToday(alice), 20 * USDC);
    }

    function test_release_global_daily_limit() public {
        usdc.mint(address(vault), 1_000 * USDC);
        vm.startPrank(relayer);
        // five distinct recipients at the per-address cap = 200 USDC
        for (uint256 i = 0; i < 5; i++) {
            address r = address(uint160(0x1000 + i));
            vault.release(r, 20 * USDC, bytes32(i * 2));
            vault.release(r, 20 * USDC, bytes32(i * 2 + 1));
        }
        assertEq(vault.globalSpentToday(), MAX_DAY);
        vm.expectRevert(abi.encodeWithSelector(MezoFloat.ExceedsGlobalDailyLimit.selector, MAX_DAY + USDC, MAX_DAY));
        vault.release(address(0x2000), USDC, bytes32("over"));
        vm.stopPrank();
    }

    function test_release_reverts_when_float_empty_and_ref_stays_unused() public {
        vm.prank(admin);
        vault.withdraw(admin, 300 * USDC);

        vm.prank(relayer);
        vm.expectRevert();
        vault.release(alice, USDC, bytes32("r1"));
        assertFalse(vault.refUsed(bytes32("r1")));
        assertEq(vault.globalSpentToday(), 0);
    }

    function testFuzz_release_never_exceeds_limits(uint256 amount, address recipient) public {
        vm.assume(recipient != address(0) && recipient != address(vault));
        amount = bound(amount, 1, MAX_TX);
        vm.prank(relayer);
        vault.release(recipient, amount, bytes32("f"));
        assertLe(vault.addressSpentToday(recipient), MAX_ADDR);
        assertLe(vault.globalSpentToday(), MAX_DAY);
        assertEq(usdc.balanceOf(recipient), amount);
    }

    // --- pause -----------------------------------------------------------

    function test_guardian_can_pause_but_not_unpause() public {
        vm.prank(guardian);
        vault.pause();

        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.release(alice, USDC, bytes32("r1"));

        vm.prank(guardian);
        vm.expectRevert();
        vault.unpause();

        vm.prank(admin);
        vault.unpause();

        vm.prank(relayer);
        vault.release(alice, USDC, bytes32("r1"));
    }

    function test_admin_can_pause_and_stranger_cannot() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.pause();

        vm.prank(admin);
        vault.pause();
        assertTrue(vault.paused());
    }

    // --- admin -----------------------------------------------------------

    function test_withdraw_works_while_paused() public {
        vm.prank(guardian);
        vault.pause();
        vm.prank(admin);
        vault.withdraw(bob, 100 * USDC);
        assertEq(usdc.balanceOf(bob), 100 * USDC);
    }

    function test_withdraw_admin_only_and_validates() public {
        vm.prank(relayer);
        vm.expectRevert();
        vault.withdraw(relayer, USDC);

        vm.startPrank(admin);
        vm.expectRevert(MezoFloat.ZeroAddress.selector);
        vault.withdraw(address(0), USDC);
        vm.expectRevert(MezoFloat.ZeroAmount.selector);
        vault.withdraw(admin, 0);
        vm.stopPrank();
    }

    function test_setLimits() public {
        vm.prank(admin);
        vault.setLimits(10 * USDC, 20 * USDC, 100 * USDC);
        assertEq(vault.maxPerTx(), 10 * USDC);
        assertEq(vault.maxPerAddressPerDay(), 20 * USDC);
        assertEq(vault.maxGlobalPerDay(), 100 * USDC);

        vm.startPrank(admin);
        vm.expectRevert(MezoFloat.InvalidLimits.selector);
        vault.setLimits(0, 20 * USDC, 100 * USDC);
        vm.expectRevert(MezoFloat.InvalidLimits.selector);
        vault.setLimits(30 * USDC, 20 * USDC, 100 * USDC);
        vm.expectRevert(MezoFloat.InvalidLimits.selector);
        vault.setLimits(10 * USDC, 200 * USDC, 100 * USDC);
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert();
        vault.setLimits(USDC, USDC, USDC);
    }

    function test_admin_transfer_is_delayed_two_step() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        vault.beginDefaultAdminTransfer(newAdmin);

        vm.prank(newAdmin);
        vm.expectRevert();
        vault.acceptDefaultAdminTransfer();

        vm.warp(block.timestamp + ADMIN_DELAY + 1);
        vm.prank(newAdmin);
        vault.acceptDefaultAdminTransfer();
        assertEq(vault.defaultAdmin(), newAdmin);
    }

    function test_constructor_rejects_bad_params() public {
        vm.expectRevert(MezoFloat.ZeroAddress.selector);
        new MezoFloat(IERC20(address(0)), admin, ADMIN_DELAY, relayer, guardian, MAX_TX, MAX_ADDR, MAX_DAY);
        vm.expectRevert(MezoFloat.ZeroAddress.selector);
        new MezoFloat(IERC20(address(usdc)), admin, ADMIN_DELAY, address(0), guardian, MAX_TX, MAX_ADDR, MAX_DAY);
        vm.expectRevert(MezoFloat.InvalidLimits.selector);
        new MezoFloat(IERC20(address(usdc)), admin, ADMIN_DELAY, relayer, guardian, 0, MAX_ADDR, MAX_DAY);
    }
}
