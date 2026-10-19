// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MezoDeposit
/// @notice Mezo-side entry point. A user deposits MUSD, mUSDC or native BTC and names a Base
///         address. Funds are forwarded straight to the treasury (this contract never holds them)
///         and a `Deposit` event is emitted. The relayer watches the event and pays USDC from the
///         Base float (`MezoFloat.release`) using the deposit `id` as the single-use `ref`.
/// @dev Payout is off-chain logic. This contract only records intent and moves funds to the
///      treasury, so it holds no value and has a small surface.
contract MezoDeposit is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @dev Token key used for native BTC (the gas token on Mezo, 18 decimals).
    address public constant NATIVE = address(0);

    struct TokenConfig {
        bool enabled;
        uint256 minAmount; // in the token's own units
        uint256 maxAmount; // in the token's own units
    }

    /// @notice Where deposited funds are forwarded.
    address public treasury;
    /// @notice Number of deposits made so far; also the next nonce.
    uint256 public nextNonce;

    mapping(address token => TokenConfig) public tokenConfig;

    event Deposit(
        uint256 indexed nonce,
        bytes32 indexed id,
        address indexed sender,
        address token,
        uint256 amount,
        address recipient
    );
    event TokenConfigured(address indexed token, bool enabled, uint256 minAmount, uint256 maxAmount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    error ZeroAddress();
    error InvalidTreasury();
    error InvalidRecipient();
    error TokenNotEnabled(address token);
    error AmountOutOfRange(uint256 amount, uint256 min, uint256 max);
    error InvalidTokenConfig();
    error TransferShortfall(uint256 expected, uint256 received);
    error NativeTransferFailed();
    error NativeKeyNotAllowed();

    constructor(address admin, uint48 adminTransferDelay, address guardian, address treasury_)
        AccessControlDefaultAdminRules(adminTransferDelay, admin)
    {
        if (guardian == address(0)) revert ZeroAddress();
        _grantRole(GUARDIAN_ROLE, guardian);
        _setTreasury(treasury_);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Deposit an ERC-20 (MUSD or mUSDC). Requires prior approval to this contract.
    /// @param token The token to deposit. Must be enabled.
    /// @param amount Amount in the token's own units.
    /// @param recipient Address on Base that will receive USDC.
    function deposit(address token, uint256 amount, address recipient)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 id)
    {
        if (token == NATIVE) revert NativeKeyNotAllowed();
        _validate(token, amount, recipient);

        IERC20 erc20 = IERC20(token);
        uint256 balanceBefore = erc20.balanceOf(treasury);
        erc20.safeTransferFrom(msg.sender, treasury, amount);
        uint256 received = erc20.balanceOf(treasury) - balanceBefore;
        if (received != amount) revert TransferShortfall(amount, received);

        id = _record(token, amount, recipient);
    }

    /// @notice Deposit native BTC.
    /// @param recipient Address on Base that will receive USDC.
    function depositNative(address recipient) external payable nonReentrant whenNotPaused returns (bytes32 id) {
        _validate(NATIVE, msg.value, recipient);

        (bool ok,) = treasury.call{value: msg.value}("");
        if (!ok) revert NativeTransferFailed();

        id = _record(NATIVE, msg.value, recipient);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Enable, disable or change limits for a token. Use `NATIVE` for BTC.
    function setTokenConfig(address token, bool enabled, uint256 minAmount, uint256 maxAmount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (minAmount == 0 || minAmount > maxAmount) revert InvalidTokenConfig();
        tokenConfig[token] = TokenConfig(enabled, minAmount, maxAmount);
        emit TokenConfigured(token, enabled, minAmount, maxAmount);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(newTreasury);
    }

    /// @notice Stop new deposits. Callable by the guardian or the admin.
    function pause() external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /// @notice Resume deposits. Admin only.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _validate(address token, uint256 amount, address recipient) private view {
        if (recipient == address(0)) revert InvalidRecipient();
        TokenConfig memory cfg = tokenConfig[token];
        if (!cfg.enabled) revert TokenNotEnabled(token);
        if (amount < cfg.minAmount || amount > cfg.maxAmount) {
            revert AmountOutOfRange(amount, cfg.minAmount, cfg.maxAmount);
        }
    }

    function _record(address token, uint256 amount, address recipient) private returns (bytes32 id) {
        uint256 nonce = nextNonce++;
        id = keccak256(abi.encode(block.chainid, address(this), nonce));
        emit Deposit(nonce, id, msg.sender, token, amount, recipient);
    }

    function _setTreasury(address newTreasury) private {
        if (newTreasury == address(0)) revert ZeroAddress();
        if (newTreasury == address(this)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
