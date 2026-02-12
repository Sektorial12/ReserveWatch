RPC_URL ?= https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY ?= $(CRE_ETH_PRIVATE_KEY)

.PHONY: deploy test clean

deploy:
	@echo "Deploying LiabilityToken and ReserveWatchReceiver..."
	solc --bin --abi src/LiabilityToken.sol src/ReserveWatchReceiver.sol -o build --overwrite
	@echo "Manual deployment steps:"
	@echo "1. Deploy LiabilityToken (constructor takes no args)"
	@echo "2. Deploy ReserveWatchReceiver(forwarder, liabilityToken, minCoverageBps)"
	@echo "   - forwarder: 0x15fC6ae953E024d975e77382eEeC56A9101f9F88"
	@echo "   - liabilityToken: <from step 1>"
	@echo "   - minCoverageBps: 10000"
	@echo "3. Call LiabilityToken.setGuardian(receiver) from owner"

test:
	solc --bin src/LiabilityToken.sol src/ReserveWatchReceiver.sol -o build --overwrite
	@echo "Run tests with a local test framework or use 'forge test' if available"

clean:
	rm -rf build/
