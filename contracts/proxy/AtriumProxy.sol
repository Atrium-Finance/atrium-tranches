// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.35;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title  AtriumProxy
 * @notice Production ERC-1967 proxy for the Atrium stack. A thin
 *         concrete wrapper that forces {ERC1967Proxy} into the project
 *         artifact set so Hardhat Ignition can deploy it by name. The
 *         implementation is set and atomically initialised in the
 *         constructor — `data` is the encoded `initialize(...)` call.
 * @dev    Only {AccessControlManager} carries a UUPS `_authorizeUpgrade`
 *         hook, so only its proxy is upgradeable. Every other component
 *         sits behind this same proxy for storage isolation and one-shot
 *         initialisation, but is effectively immutable until a UUPS hook
 *         is added (the project's upgradeability decision is still open).
 */
contract AtriumProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
