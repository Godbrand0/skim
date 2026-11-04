// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The token a `MezoFloat` pays is exposed as `usdc()` whatever it actually is.
interface IFloatToken {
    function usdc() external view returns (address);
}

/// @title MezoFloatRefiller
/// @notice Lets the keeper top up the Mezo-side floats from the treasury, so deposits on one side refill the float on
///         the other without a bridge: mUSDC deposited on Mezo refills the mUSDC float that pays Base-to-Mezo users,
///         and MUSD deposited on Mezo refills the MUSD float. It never holds funds: it pulls from the treasury (which must
///         approve it) straight into a float.
/// @dev A compromised keeper can only move tokens from the treasury into floats the admin has listed, for the token each
///      float pays, up to the per-call cap and the treasury's allowance. It cannot send anything anywhere else.
contract MezoFloatRefiller is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct FloatConfig {
        IERC20 token;
        uint256 maxPerCall; // 0 means the float is not listed
    }

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    address public treasury;
    mapping(address float => FloatConfig) public floats;

    event Refilled(address indexed keeper, address indexed float, address indexed token, uint256 amount);
    event FloatListed(address indexed float, address indexed token, uint256 maxPerCall);
    event FloatRemoved(address indexed float);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error ZeroAddress();
    error ZeroAmount();
    error FloatNotListed(address float);
    error TokenMismatch(address floatToken, address given);
    error AmountTooLarge(uint256 amount, uint256 max);

    constructor(address admin, uint48 adminTransferDelay, address keeper, address treasury_)
        AccessControlDefaultAdminRules(adminTransferDelay, admin)
    {
        if (keeper == address(0)) revert ZeroAddress();
        _grantRole(KEEPER_ROLE, keeper);
        _setTreasury(treasury_);
    }

    /// @notice Move `amount` of the float's token from the treasury into the float.
    function refill(address float_, uint256 amount) external onlyRole(KEEPER_ROLE) nonReentrant {
        FloatConfig memory cfg = floats[float_];
        if (cfg.maxPerCall == 0) revert FloatNotListed(float_);
        if (amount == 0) revert ZeroAmount();
        if (amount > cfg.maxPerCall) revert AmountTooLarge(amount, cfg.maxPerCall);
        cfg.token.safeTransferFrom(treasury, float_, amount);
        emit Refilled(msg.sender, float_, address(cfg.token), amount);
    }

    /// @notice List a float, or change its cap. `token` must be the token the float pays, so a typo cannot send
    ///         the wrong asset into it.
    function listFloat(address float_, address token, uint256 maxPerCall) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (float_ == address(0) || token == address(0)) revert ZeroAddress();
        if (maxPerCall == 0) revert ZeroAmount();
        address floatToken = IFloatToken(float_).usdc();
        if (floatToken != token) revert TokenMismatch(floatToken, token);
        floats[float_] = FloatConfig(IERC20(token), maxPerCall);
        emit FloatListed(float_, token, maxPerCall);
    }

    function removeFloat(address float_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete floats[float_];
        emit FloatRemoved(float_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(treasury_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }
}
