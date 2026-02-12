import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import dotenv from "dotenv"
import solc from "solc"
import { createPublicClient, createWalletClient, http } from "viem"
import { sepolia } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
})

const SRC_DIR = path.resolve(__dirname, "./src")
const WORKFLOW_CONFIG_PATH = path.resolve(__dirname, "../../reservewatch-workflow/config.staging.json")
const SERVER_PROJECTS_PATH = path.resolve(__dirname, "../../server/projects.json")

const MOCK_FORWARDER_SEPOLIA = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88"
const MIN_COVERAGE_BPS = 10000n
const INITIAL_SUPPLY = 1_000_000n

const buildSources = () => {
  const sources = {}
  const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(".sol")) continue
    const fullPath = path.join(SRC_DIR, entry.name)
    sources[`src/${entry.name}`] = { content: fs.readFileSync(fullPath, "utf8") }
  }

  return sources
}

const compileContracts = () => {
  const input = {
    language: "Solidity",
    sources: buildSources(),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  }

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (importPath) => {
        const cleaned = importPath.replace(/^\.\//, "")
        const tryPaths = [path.join(SRC_DIR, cleaned), path.join(SRC_DIR, importPath)]

        for (const p of tryPaths) {
          if (fs.existsSync(p)) {
            return { contents: fs.readFileSync(p, "utf8") }
          }
        }

        return { error: `File not found: ${importPath}` }
      },
    })
  )

  const errors = Array.isArray(output.errors) ? output.errors : []
  const fatal = errors.filter((e) => e.severity === "error")
  if (fatal.length) {
    const message = fatal.map((e) => e.formattedMessage || e.message).join("\n")
    throw new Error(message)
  }

  const liability = output.contracts?.["src/LiabilityToken.sol"]?.LiabilityToken
  const receiver = output.contracts?.["src/ReserveWatchReceiver.sol"]?.ReserveWatchReceiver

  if (!liability?.evm?.bytecode?.object || !receiver?.evm?.bytecode?.object) {
    throw new Error("Compilation output missing bytecode")
  }

  return {
    LiabilityToken: {
      abi: liability.abi,
      bytecode: `0x${liability.evm.bytecode.object}`,
    },
    ReserveWatchReceiver: {
      abi: receiver.abi,
      bytecode: `0x${receiver.evm.bytecode.object}`,
    },
  }
}

async function main() {
  let privateKey = process.env.PRIVATE_KEY || process.env.CRE_ETH_PRIVATE_KEY
  
  if (!privateKey || privateKey.includes("1111111111111111111111111111111111111111111111111111111111111111")) {
    console.error("Please set a valid private key in .env file (CRE_ETH_PRIVATE_KEY)")
    console.error("Update .env with your funded Sepolia account private key")
    process.exit(1)
  }
  
  // Ensure private key has 0x prefix
  if (!privateKey.startsWith("0x")) {
    privateKey = "0x" + privateKey
  }
  
  const account = privateKeyToAccount(privateKey)

  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
  const compiled = compileContracts()
  
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl)
  })
  
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl)
  })

  console.log("Deploying contracts with account:", account.address)

  // Deploy LiabilityToken
  const liabilityTokenHash = await walletClient.deployContract({
    abi: compiled.LiabilityToken.abi,
    bytecode: compiled.LiabilityToken.bytecode,
    account
  })
  
  const liabilityTokenAddress = await publicClient.waitForTransactionReceipt({ hash: liabilityTokenHash })
  console.log("LiabilityToken deployed at:", liabilityTokenAddress.contractAddress)

  // Deploy ReserveWatchReceiver
  const receiverHash = await walletClient.deployContract({
    abi: compiled.ReserveWatchReceiver.abi,
    bytecode: compiled.ReserveWatchReceiver.bytecode,
    args: [
      MOCK_FORWARDER_SEPOLIA,
      liabilityTokenAddress.contractAddress,
      MIN_COVERAGE_BPS
    ],
    account
  })
  
  const receiverAddress = await publicClient.waitForTransactionReceipt({ hash: receiverHash })
  console.log("ReserveWatchReceiver deployed at:", receiverAddress.contractAddress)

  // Set guardian
  const setGuardianHash = await walletClient.writeContract({
    address: liabilityTokenAddress.contractAddress,
    abi: compiled.LiabilityToken.abi,
    functionName: "setGuardian",
    args: [receiverAddress.contractAddress],
    account
  })
  
  await publicClient.waitForTransactionReceipt({ hash: setGuardianHash })
  console.log("Guardian set successfully")

  const mintHash = await walletClient.writeContract({
    address: liabilityTokenAddress.contractAddress,
    abi: compiled.LiabilityToken.abi,
    functionName: "mint",
    args: [account.address, INITIAL_SUPPLY],
    account,
  })

  await publicClient.waitForTransactionReceipt({ hash: mintHash })
  console.log("Initial supply minted")

  if (fs.existsSync(WORKFLOW_CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(WORKFLOW_CONFIG_PATH, "utf8"))
    const updated = {
      ...existing,
      receiverAddress: receiverAddress.contractAddress,
      liabilityTokenAddress: liabilityTokenAddress.contractAddress,
      supplyLiabilityTokenAddress: liabilityTokenAddress.contractAddress,
      attestationVersion: "v2",
    }
    fs.writeFileSync(WORKFLOW_CONFIG_PATH, JSON.stringify(updated, null, 2) + "\n")
    console.log("Updated reservewatch-workflow/config.staging.json")
  }

  if (fs.existsSync(SERVER_PROJECTS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SERVER_PROJECTS_PATH, "utf8"))
      const projects = Array.isArray(raw?.projects) ? raw.projects : []
      const nextProjects = projects.map((p) => {
        if (p?.id !== "reservewatch-sepolia") return p
        return {
          ...p,
          receiverAddress: receiverAddress.contractAddress,
          liabilityTokenAddress: liabilityTokenAddress.contractAddress,
        }
      })

      const next = {
        ...raw,
        projects: nextProjects,
      }
      fs.writeFileSync(SERVER_PROJECTS_PATH, JSON.stringify(next, null, 2) + "\n")
      console.log("Updated server/projects.json")
    } catch {
      // ignore
    }
  }

  console.log("\nDeployment complete!")
  console.log("LiabilityToken:", liabilityTokenAddress.contractAddress)
  console.log("ReserveWatchReceiver:", receiverAddress.contractAddress)
  console.log("\nNext: run CRE simulation")
}

main().catch(console.error)
