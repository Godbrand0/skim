// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MezoBtcFloat} from "../src/MezoBtcFloat.sol";

contract RejectsBtc {
    receive() external payable {
        revert("no");
    }
}

contract Reenters {
    MezoBtcFloat public f;
    bool public reentered;

    constructor(MezoBtcFloat f_) {
        f = f_;
    }

    receive() external payable {
        try f.release(address(this), 1, bytes32("again")) {
            reentered = true;
        } catch {}
    }
}

contract MezoBtcFloatTest is Test {
    MezoBtcFloat f;
    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    function setUp() public {
        f = new MezoBtcFloat(admin, 2 days, relayer, guardian, 3e14, 6e14, 3e15);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(f).call{value: 1e16}("");
        assertTrue(ok);
    }

    function test_funding_and_balance() public view {
        assertEq(f.floatBalance(), 1e16);
    }

    function test_release_pays_native_btc_once() public {
        vm.prank(relayer);
        f.release(alice, 2e14, bytes32("a"));
        assertEq(alice.balance, 2e14);
        assertEq(f.floatBalance(), 1e16 - 2e14);
        assertTrue(f.refUsed(bytes32("a")));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MezoBtcFloat.RefAlreadyUsed.selector, bytes32("a")));
        f.release(alice, 2e14, bytes32("a"));
    }

    function test_only_relayer() public {
        vm.expectRevert();
        f.release(alice, 1, bytes32("x"));
    }

    function test_limits() public {
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MezoBtcFloat.ExceedsPerTxLimit.selector, 4e14, 3e14));
        f.release(alice, 4e14, bytes32("big"));
        f.release(alice, 3e14, bytes32("1"));
        f.release(alice, 3e14, bytes32("2"));
        vm.expectRevert(abi.encodeWithSelector(MezoBtcFloat.ExceedsAddressDailyLimit.selector, 9e14, 6e14));
        f.release(alice, 3e14, bytes32("3"));
        vm.stopPrank();
        assertEq(f.addressSpentToday(alice), 6e14);
        vm.warp(block.timestamp + 1 days);
        vm.prank(relayer);
        f.release(alice, 3e14, bytes32("4"));
    }

    function test_global_limit() public {
        vm.startPrank(relayer);
        for (uint256 i; i < 10; i++) {
            f.release(makeAddr(string(abi.encode("u", i))), 3e14, bytes32(i + 100));
        }
        vm.expectRevert(abi.encodeWithSelector(MezoBtcFloat.ExceedsGlobalDailyLimit.selector, 3.3e15, 3e15));
        f.release(makeAddr("last"), 3e14, bytes32("last"));
        vm.stopPrank();
    }

    function test_reverts_when_float_empty_and_ref_stays_unused() public {
        vm.prank(admin);
        f.withdraw(admin, 1e16);
        vm.prank(relayer);
        vm.expectRevert(MezoBtcFloat.NativeTransferFailed.selector);
        f.release(alice, 1e14, bytes32("e"));
        assertFalse(f.refUsed(bytes32("e")));
    }

    function test_rejecting_recipient_reverts_without_burning_ref() public {
        RejectsBtc r = new RejectsBtc();
        vm.prank(relayer);
        vm.expectRevert(MezoBtcFloat.NativeTransferFailed.selector);
        f.release(address(r), 1e14, bytes32("r"));
        assertFalse(f.refUsed(bytes32("r")));
    }

    function test_reentrancy_blocked() public {
        Reenters r = new Reenters(f);
        vm.prank(relayer);
        f.release(address(r), 1e14, bytes32("re"));
        assertFalse(r.reentered());
    }

    function test_guardian_pauses_only_admin_resumes_and_withdraw_works_paused() public {
        vm.prank(guardian);
        f.pause();
        vm.prank(relayer);
        vm.expectRevert();
        f.release(alice, 1e14, bytes32("p"));
        vm.prank(guardian);
        vm.expectRevert();
        f.unpause();
        vm.prank(admin);
        f.withdraw(admin, 1e15);
        assertEq(admin.balance, 1e15);
        vm.prank(admin);
        f.unpause();
    }

    function test_bad_inputs() public {
        vm.startPrank(relayer);
        vm.expectRevert(MezoBtcFloat.InvalidRecipient.selector);
        f.release(address(0), 1, bytes32("z"));
        vm.expectRevert(MezoBtcFloat.InvalidRecipient.selector);
        f.release(address(f), 1, bytes32("z"));
        vm.expectRevert(MezoBtcFloat.ZeroAmount.selector);
        f.release(alice, 0, bytes32("z"));
        vm.stopPrank();
    }

    function test_constructor_rejects_bad_params() public {
        vm.expectRevert(MezoBtcFloat.ZeroAddress.selector);
        new MezoBtcFloat(admin, 2 days, address(0), guardian, 1, 1, 1);
        vm.expectRevert(MezoBtcFloat.InvalidLimits.selector);
        new MezoBtcFloat(admin, 2 days, relayer, guardian, 2, 1, 1);
    }

    function testFuzz_release_never_exceeds_limits(uint256 amount, address to) public {
        vm.assume(to != address(0) && to != address(f) && to.code.length == 0 && uint160(to) > 100);
        amount = bound(amount, 1, 1e16);
        vm.prank(relayer);
        try f.release(to, amount, bytes32("fz")) {
            assertLe(amount, 3e14);
            assertLe(f.addressSpentToday(to), 6e14);
        } catch {}
    }
}
