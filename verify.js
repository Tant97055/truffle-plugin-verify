const axios = require('axios')
const querystring = require('querystring')
const sleep = require('await-sleep')
const { merge } = require('sol-merger')
const fs = require('fs')

const API_URLS = {
  1: 'https://api.etherscan.io/api',
  3: 'https://api-ropsten.etherscan.io/api',
  4: 'https://api-rinkeby.etherscan.io/api',
  5: 'https://api-goerli.etherscan.io/api',
  42: 'https://api-kovan.etherscan.io/api'
}

const VerificationStatus = {
  FAILED: 'Fail - Unable to verify',
  SUCCESS: 'Pass - Verified',
  PENDING: 'Pending in queue'
}

const fetchConstructorValues = async (artifact, options) => {
  const contractAddress = artifact.networks[`${options.networkId}`].address
  // fetch the contract creation transaction and extract the input data
  const res = await axios.get(
    `${options.apiUrl}?module=account&action=txlist&address=${contractAddress}&page=1&sort=asc&offset=1`
  )

  if (res.data && res.data.status === '1') {
    const bytecodeLength = artifact.bytecode.length
    // the last part of the transaction data is the constructor parameters
    return res.data.result[0].input.substring(bytecodeLength)
  }

  throw new Error('Failed to fetch constructor arguments')
}

const sendVerifyRequest = async (artifact, options) => {
  const encodedConstructorArgs = await fetchConstructorValues(artifact, options)
  const mergedSource = await merge(artifact.sourcePath)
  const postQueries = {
    apikey: options.apiKey,
    module: 'contract',
    action: 'verifysourcecode',
    // TODO: detect deployed networks
    contractaddress: artifact.networks[`${options.networkId}`].address,
    sourceCode: mergedSource,
    contractname: artifact.contractName,
    compilerversion: `v${artifact.compiler.version.replace('.Emscripten.clang', '')}`,
    optimizationUsed: options.optimizationUsed,
    runs: options.runs,
    constructorArguements: encodedConstructorArgs
  }

  return axios.post(
    options.apiUrl,
    querystring.stringify(postQueries)
  )
}

const verificationStatus = async (guid, options) => {
  while (true) {
    await sleep(1000)

    const verificationResult = await axios.get(
      `${options.apiUrl}?module=contract&action=checkverifystatus&apikey=${options.apiKey}&guid=${guid}`
    )

    if (verificationResult.data.result !== VerificationStatus.PENDING) {
      return verificationResult.data.result
    }
  }
}

const parseConfig = (config) => {
  if (!config.networks[config.network]) {
    throw new Error(`No network configuration found for network ${config.network}`)
  }

  const networkId = (config.networks[config.network] || {}).network_id || 1
  const apiUrl = API_URLS[networkId]

  if (!apiUrl) {
    throw new Error(`Incorrect network id specified for network ${config.network}`)
  }

  if (!config.api_keys || !config.api_keys.etherscan) {
    throw new Error('No Etherscan API key specified')
  }

  const apiKey = config.api_keys.etherscan

  if (config._.length < 2) {
    throw new Error('No contract name specified')
  }

  const contractName = config._[1]
  const workingDir = config.working_directory
  const contractsBuildDir = config.contracts_build_directory
  const optimizerSettings = config.compilers.solc.settings.optimizer

  return {
    apiUrl,
    apiKey,
    networkId,
    contractName,
    workingDir,
    contractsBuildDir,
    // Note: API docs state enabled = 0, disbled = 1, but empiric evidence suggests reverse
    optimizationUsed: optimizerSettings.enabled ? 1 : 0,
    runs: optimizerSettings.runs
  }
}

module.exports = async (config) => {
  try {
    const options = parseConfig(config)
    const artifactPath = `${options.contractsBuildDir}/${options.contractName}.json`

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact for contract ${options.contractName} not found`)
    }

    const artifact = require(artifactPath)

    if (!artifact.networks || !artifact.networks[`${options.networkId}`]) {
      throw new Error(`No instance of contract ${options.contractName} found on network ${config.network}`)
    }

    try {
      const res = await sendVerifyRequest(artifact, options)

      if (res.data && res.data.status === '1') {
        const status = await verificationStatus(res.data.result, options)
        console.log(status)
      } else {
        throw new Error()
      }
    } catch (e) {
      throw new Error(`Failed to connect to Etherscan API at url ${options.apiUrl}`)
    }
  } catch (e) {
    console.error(e.message)
  }
}
