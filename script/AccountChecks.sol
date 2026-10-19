// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Guards for deploy scripts. An EOA that has signed an EIP-7702 authorization carries the
/// 23-byte code `0xef0100 ++ delegate`. Its balance can be controlled by that delegate's code (for
/// example, forwarding every incoming transfer elsewhere), so it must never hold a protocol role.
library AccountChecks {
    function isDelegated(address a) internal view returns (bool) {
        bytes memory code = a.code;
        return code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    function requirePlain(address a, string memory label) internal view {
        if (isDelegated(a)) {
            revert(string.concat(label, " is an EIP-7702 delegated account. Use a fresh plain key instead."));
        }
    }
}
