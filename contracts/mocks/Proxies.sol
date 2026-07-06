// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Trivial concrete wrapper that forces ERC1967Proxy into the project artifact set.
contract ProjectERC1967Proxy is ERC1967Proxy {
    constructor(address impl, bytes memory data) ERC1967Proxy(impl, data) {}
}
