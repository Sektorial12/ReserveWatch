import {
  CronCapability,
  EVMClient,
  HTTPClient,
  Runner,
  getNetwork,
  handler,
  type Runtime,
} from "@chainlink/cre-sdk"
import {
  bytesToHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  recoverMessageAddress,
  type Address,
  zeroAddress,
} from "viem"
import { z } from "zod"

import { LiabilityTokenAbi, ReserveWatchReceiverAbi } from "../contracts/abi"

type ReserveSourceResponse = {
  timestamp: number
  reserveUsd: string
  navUsd?: string
  source: string
  signer?: string
  signature?: string
}

type ReserveData = {
  asOfTimestamp: bigint
  reserveUsd: bigint
  navUsd?: bigint
  source: string
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

const hexToBytes = (hex: string): Uint8Array => {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex

  if (cleanHex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${hex}`)
  }

  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16)
  }

  return bytes
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let output = ""

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const triple = a * 65536 + b * 256 + c

    output += BASE64_ALPHABET[Math.floor(triple / 262144) & 63]
    output += BASE64_ALPHABET[Math.floor(triple / 4096) & 63]
    output += i + 1 < bytes.length ? BASE64_ALPHABET[Math.floor(triple / 64) & 63] : "="
    output += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "="
  }

  return output
}

const hexToBase64 = (hex: string): string => bytesToBase64(hexToBytes(hex))

const encodeCallMsg = (payload: { from: string; to: string; data: string }) => ({
  from: hexToBase64(payload.from),
  to: hexToBase64(payload.to),
  data: hexToBase64(payload.data),
})

const callContractWithFallback = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  call: ReturnType<typeof encodeCallMsg>
): { data: Uint8Array } => {
  const perform = (blockNumber?: unknown) => {
    const payload: any = { call }
    if (blockNumber) payload.blockNumber = blockNumber
    return evmClient.callContract(runtime, payload).result() as any
  }

  const blockTag = runtime.config.evmReadBlockTag || "finalized"
  const allowFallback = runtime.config.evmReadFallbackToLatest !== false
  const retries = (() => {
    if (!runtime.config.evmReadRetries) return 0
    const n = Number(runtime.config.evmReadRetries)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  })()

  const primaryBlockNumber = blockTag === "finalized" ? LAST_FINALIZED_BLOCK_NUMBER : undefined
  const fallbackBlockNumber = blockTag === "finalized" ? undefined : LAST_FINALIZED_BLOCK_NUMBER
  const blocks = allowFallback ? [primaryBlockNumber, fallbackBlockNumber] : [primaryBlockNumber]

  let lastErr: unknown = null

  for (const b of blocks) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = perform(b)
        if (r?.data && r.data.length > 0) return r
      } catch (err) {
        lastErr = err
      }
    }
  }

  if (lastErr) throw lastErr
  return perform(primaryBlockNumber)
}

const LAST_FINALIZED_BLOCK_NUMBER = {
  absVal: "Aw==",
  sign: "-1",
}

const bytesToAscii = (bytes: Uint8Array): string => {
  let result = ""

  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i])
  }

  return result
}

const configSchema = z.object({
  schedule: z.string(),
  chainSelectorName: z.string(),
  supplyChainSelectorName: z.string().optional(),
  attestationChainSelectorName: z.string().optional(),
  receiverAddress: z.string(),
  liabilityTokenAddress: z.string(),
  supplyLiabilityTokenAddress: z.string().optional(),
  reserveUrlPrimary: z.string(),
  reserveUrlSecondary: z.string(),
  reserveExpectedSignerAddress: z.string().optional(),
  reserveExpectedSignerAddressPrimary: z.string().optional(),
  reserveExpectedSignerAddressSecondary: z.string().optional(),
  reserveConsensusMode: z.enum(["primary_only", "require_match", "conservative_min"]).optional(),
  reserveMaxMismatchBps: z.string().optional(),
  reserveMaxMismatchRatio: z.string().optional(),
  reserveMaxAgeS: z.string().optional(),
  reserveStalePolicy: z.enum(["fallback_secondary", "fail_closed"]).optional(),
  evmReadBlockTag: z.enum(["finalized", "latest"]).optional(),
  evmReadFallbackToLatest: z.boolean().optional(),
  evmReadRetries: z.string().optional(),
  attestationVersion: z.enum(["v1", "v2"]).optional(),
  minCoverageBps: z.string(),
  gasLimit: z.string(),
})

type Config = z.infer<typeof configSchema>

const parseConfig = (configBytes: Uint8Array): Config => {
  const parsed = JSON.parse(bytesToAscii(configBytes))
  return configSchema.parse(parsed)
}

const reserveMessage = ({
  timestamp,
  reserveUsd,
  navUsd,
  source,
}: {
  timestamp: number
  reserveUsd: string
  navUsd?: string
  source: string
}) => {
  if (navUsd !== undefined) {
    return `ReserveWatch:v2|source=${source}|reserveUsd=${reserveUsd}|navUsd=${navUsd}|timestamp=${timestamp}`
  }
  return `ReserveWatch:v1|source=${source}|reserveUsd=${reserveUsd}|timestamp=${timestamp}`
}

const normalizeAddress = (a?: string | null) => {
  if (!a) return ""
  return String(a).toLowerCase()
}

const verifyReserveSignature = async ({
  parsed,
  expectedSigner,
}: {
  parsed: ReserveSourceResponse
  expectedSigner: string
}): Promise<boolean> => {
  if (!expectedSigner) return true
  if (!parsed?.signature) return false
  if (!parsed?.signer) return false
  if (normalizeAddress(parsed.signer) !== normalizeAddress(expectedSigner)) return false

  if (typeof parsed.signature !== "string") return false
  if (!parsed.signature.startsWith("0x")) return false

  try {
    const recovered = await recoverMessageAddress({
      message: reserveMessage({
        timestamp: parsed.timestamp,
        reserveUsd: parsed.reserveUsd,
        navUsd: typeof parsed.navUsd === "string" ? parsed.navUsd : undefined,
        source: parsed.source,
      }),
      signature: parsed.signature as `0x${string}`,
    })
    return normalizeAddress(recovered) === normalizeAddress(expectedSigner)
  } catch {
    return false
  }
}

const fetchReserve = async (runtime: Runtime<Config>): Promise<ReserveData> => {
  const httpClient = new HTTPClient()

  const expectedSignerAll = runtime.config.reserveExpectedSignerAddress || ""
  const expectedSignerPrimary = runtime.config.reserveExpectedSignerAddressPrimary || expectedSignerAll
  const expectedSignerSecondary = runtime.config.reserveExpectedSignerAddressSecondary || expectedSignerAll

  const consensusMode = runtime.config.reserveConsensusMode || "primary_only"
  const stalePolicy = runtime.config.reserveStalePolicy || "fallback_secondary"
  const nowS = Math.floor(Date.now() / 1000)

  const maxAgeS = (() => {
    if (!runtime.config.reserveMaxAgeS) return null
    const n = Number(runtime.config.reserveMaxAgeS)
    return Number.isFinite(n) && n > 0 ? n : null
  })()

  const maxMismatchBps = (() => {
    if (runtime.config.reserveMaxMismatchBps) {
      try {
        return BigInt(runtime.config.reserveMaxMismatchBps)
      } catch {
        return null
      }
    }
    if (runtime.config.reserveMaxMismatchRatio) {
      const n = Number(runtime.config.reserveMaxMismatchRatio)
      if (!Number.isFinite(n) || n < 0) return null
      return BigInt(Math.floor(n * 10_000))
    }
    return null
  })()

  const parseCandidate = async ({
    resp,
    expectedSigner,
    label,
  }: {
    resp: { statusCode: number; body: Uint8Array }
    expectedSigner: string
    label: string
  }): Promise<{ data: ReserveData | null; stale: boolean }> => {
    if (resp.statusCode !== 200) return { data: null, stale: false }
    try {
      const body = bytesToAscii(resp.body)
      const parsed = JSON.parse(body) as ReserveSourceResponse

      if (maxAgeS !== null) {
        const ageS = nowS - Number(parsed.timestamp)
        if (Number.isFinite(ageS) && ageS > maxAgeS) {
          runtime.log(`${label} reserve source stale ageS=${ageS.toString()} maxAgeS=${maxAgeS.toString()}`)
          return { data: null, stale: true }
        }
      }

      if (expectedSigner && !(await verifyReserveSignature({ parsed, expectedSigner }))) {
        return { data: null, stale: false }
      }

      return {
        data: {
          asOfTimestamp: BigInt(parsed.timestamp),
          reserveUsd: BigInt(parsed.reserveUsd),
          navUsd: typeof parsed.navUsd === "string" ? BigInt(parsed.navUsd) : undefined,
          source: parsed.source,
        },
        stale: false,
      }
    } catch {
      return { data: null, stale: false }
    }
  }

  const primaryResp = httpClient
    .sendRequest(runtime as any, {
      url: runtime.config.reserveUrlPrimary,
      method: "GET",
    })
    .result()

  const secondaryResp = httpClient
    .sendRequest(runtime as any, {
      url: runtime.config.reserveUrlSecondary,
      method: "GET",
    })
    .result()

  const primaryCandidate = await parseCandidate({
    resp: primaryResp,
    expectedSigner: expectedSignerPrimary,
    label: "primary",
  })
  const secondaryCandidate = await parseCandidate({
    resp: secondaryResp,
    expectedSigner: expectedSignerSecondary,
    label: "secondary",
  })

  const primary = primaryCandidate.data
  const secondary = secondaryCandidate.data

  if (consensusMode === "primary_only") {
    if (primary) return primary
    if (primaryCandidate.stale && stalePolicy === "fail_closed") {
      throw new Error("primary reserve source stale")
    }
    if (secondary) return secondary
    throw new Error("no valid reserve sources")
  }

  if (consensusMode === "require_match") {
    if (!primary) {
      if (primaryCandidate.stale) throw new Error("primary reserve source stale")
      throw new Error("primary reserve source invalid")
    }
    if (!secondary) {
      if (secondaryCandidate.stale) throw new Error("secondary reserve source stale")
      throw new Error("secondary reserve source invalid")
    }

    const a = primary.reserveUsd
    const b = secondary.reserveUsd
    const diff = a > b ? a - b : b - a
    const max = a > b ? a : b
    const mismatchBps = max === 0n ? 0n : (diff * 10_000n) / max

    if (maxMismatchBps !== null && mismatchBps > maxMismatchBps) {
      throw new Error("reserve sources mismatch beyond threshold")
    }

    return primary
  }

  if (consensusMode === "conservative_min") {
    if (primary && secondary) {
      const a = primary.reserveUsd
      const b = secondary.reserveUsd
      const diff = a > b ? a - b : b - a
      const max = a > b ? a : b
      const mismatchBps = max === 0n ? 0n : (diff * 10_000n) / max
      if (maxMismatchBps !== null && mismatchBps > maxMismatchBps) {
        runtime.log(`reserve source mismatch detected mismatchBps=${mismatchBps.toString()} maxMismatchBps=${maxMismatchBps.toString()}`)
      }
      return a <= b ? primary : secondary
    }
    if (primary) return primary
    if (primaryCandidate.stale && stalePolicy === "fail_closed") {
      throw new Error("primary reserve source stale")
    }
    if (secondary) return secondary
    throw new Error("no valid reserve sources")
  }

  throw new Error(`unknown reserveConsensusMode=${consensusMode}`)
}

const readLiabilitySupply = (runtime: Runtime<Config>, evmClient: EVMClient): bigint => {
  const tokenAddress = (runtime.config.supplyLiabilityTokenAddress || runtime.config.liabilityTokenAddress) as Address
  const callData = encodeFunctionData({
    abi: LiabilityTokenAbi,
    functionName: "totalSupply",
    args: [],
  })

  const contractCall = callContractWithFallback(
    runtime,
    evmClient,
    encodeCallMsg({
      from: zeroAddress,
      to: tokenAddress,
      data: callData,
    })
  )

  if (!contractCall?.data || contractCall.data.length === 0) {
    throw new Error("totalSupply call returned empty data")
  }

  const supply = decodeFunctionResult({
    abi: LiabilityTokenAbi,
    functionName: "totalSupply",
    data: bytesToHex(contractCall.data),
  }) as bigint

  return supply
}

const readMinCoverageBps = (runtime: Runtime<Config>, evmClient: EVMClient): bigint | null => {
  const callData = encodeFunctionData({
    abi: ReserveWatchReceiverAbi,
    functionName: "minCoverageBps",
    args: [],
  })

  try {
    const contractCall = callContractWithFallback(
      runtime,
      evmClient,
      encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.receiverAddress as Address,
        data: callData,
      })
    )

    if (!contractCall?.data || contractCall.data.length === 0) return null

    const minCoverageBps = decodeFunctionResult({
      abi: ReserveWatchReceiverAbi,
      functionName: "minCoverageBps",
      data: bytesToHex(contractCall.data),
    }) as bigint

    return minCoverageBps
  } catch {
    return null
  }
}

const computeCoverageBps = (reserveUsd: bigint, supply: bigint): bigint => {
  if (supply === 0n) return 0n
  return (reserveUsd * 10000n) / supply
}

const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  const attestationVersion = runtime.config.attestationVersion || "v1"
  const supplyChainSelectorName = runtime.config.supplyChainSelectorName || runtime.config.chainSelectorName
  const attestationChainSelectorName = runtime.config.attestationChainSelectorName || runtime.config.chainSelectorName

  const supplyNetwork = getNetwork({
    chainFamily: "evm",
    chainSelectorName: supplyChainSelectorName,
    isTestnet: true,
  })

  if (!supplyNetwork) {
    throw new Error(`Network not found: ${supplyChainSelectorName}`)
  }

  const attestationNetwork = getNetwork({
    chainFamily: "evm",
    chainSelectorName: attestationChainSelectorName,
    isTestnet: true,
  })

  if (!attestationNetwork) {
    throw new Error(`Network not found: ${attestationChainSelectorName}`)
  }

  const supplyEvmClient = new EVMClient(supplyNetwork.chainSelector.selector)
  const attestationEvmClient = new EVMClient(attestationNetwork.chainSelector.selector)

  const reserveData = await fetchReserve(runtime)

  const supply = readLiabilitySupply(runtime, supplyEvmClient)
  const coverageBps = computeCoverageBps(reserveData.reserveUsd, supply)

  const onchainMinCoverageBps = readMinCoverageBps(runtime, attestationEvmClient)
  const minCoverageBps = onchainMinCoverageBps ?? BigInt(runtime.config.minCoverageBps)
  const breakerTriggered = coverageBps < minCoverageBps

  const attestationPreimage =
    attestationVersion === "v2"
      ? encodeAbiParameters(
          parseAbiParameters(
            "uint256 reserveUsd,uint256 navUsd,uint256 liabilitySupply,uint256 coverageBps,uint256 asOfTimestamp,bool breakerTriggered"
          ),
          [
            reserveData.reserveUsd,
            reserveData.navUsd ?? 0n,
            supply,
            coverageBps,
            reserveData.asOfTimestamp,
            breakerTriggered,
          ]
        )
      : encodeAbiParameters(
          parseAbiParameters(
            "uint256 reserveUsd,uint256 liabilitySupply,uint256 coverageBps,uint256 asOfTimestamp,bool breakerTriggered"
          ),
          [reserveData.reserveUsd, supply, coverageBps, reserveData.asOfTimestamp, breakerTriggered]
        )

  const attestationHash = keccak256(attestationPreimage)

  const receiverCallData =
    attestationVersion === "v2"
      ? encodeFunctionData({
          abi: ReserveWatchReceiverAbi,
          functionName: "updateAttestationV2",
          args: [
            attestationHash,
            reserveData.reserveUsd,
            reserveData.navUsd ?? 0n,
            supply,
            coverageBps,
            reserveData.asOfTimestamp,
            breakerTriggered,
          ],
        })
      : encodeFunctionData({
          abi: ReserveWatchReceiverAbi,
          functionName: "updateAttestation",
          args: [
            attestationHash,
            reserveData.reserveUsd,
            supply,
            coverageBps,
            reserveData.asOfTimestamp,
            breakerTriggered,
          ],
        })

  const report = runtime
    .report({
      encodedPayload: hexToBase64(receiverCallData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  const writeResult = attestationEvmClient
    .writeReport(runtime, {
      receiver: runtime.config.receiverAddress,
      report,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result()

  const receiverStatus = writeResult.receiverContractExecutionStatus?.toString() ?? "unknown"

  runtime.log(
    `supplyChain=${supplyChainSelectorName} attestationChain=${attestationChainSelectorName} attestationVersion=${attestationVersion} policySource=${onchainMinCoverageBps !== null ? "onchain" : "config"} minCoverageBps=${minCoverageBps.toString()} reserveUsd=${reserveData.reserveUsd.toString()} navUsd=${(reserveData.navUsd ?? 0n).toString()} supply=${supply.toString()} coverageBps=${coverageBps.toString()} source=${reserveData.source}`
  )
  runtime.log(`breakerTriggered=${breakerTriggered.toString()} attestationHash=${attestationHash}`)
  runtime.log(`txStatus=${writeResult.txStatus.toString()} receiverStatus=${receiverStatus} txHash=${bytesToHex(writeResult.txHash || new Uint8Array(32))}`)

  return "ok"
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()

  return [
    handler(
      cron.trigger({
        schedule: config.schedule,
      }),
      onCronTrigger
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configParser: parseConfig,
  })

  await runner.run(initWorkflow)
}
