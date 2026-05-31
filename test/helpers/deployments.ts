import { encodeFunctionData, type Address } from "viem";
import { viem } from "./viemClients.js";

/**
 * Deploy an implementation, then wrap it in an ERC1967Proxy with the
 * encoded initializer call. Returns the proxy + impl addresses.
 */
export async function deployUUPS(
  contractName: string,
  initFnName: string,
  initArgs: any[],
  constructorArgs: any[] = [],
): Promise<{ address: Address; impl: Address }> {
  const impl = await viem.deployContract(contractName, constructorArgs);
  const implAbi = (impl as any).abi;
  const data = encodeFunctionData({
    abi: implAbi,
    functionName: initFnName,
    args: initArgs,
  });
  const proxy = await viem.deployContract("ProjectERC1967Proxy", [impl.address, data]);
  return { address: proxy.address as Address, impl: impl.address as Address };
}

export async function getAt<T = any>(contractName: string, addr: Address): Promise<T> {
  return (await viem.getContractAt(contractName, addr)) as T;
}
