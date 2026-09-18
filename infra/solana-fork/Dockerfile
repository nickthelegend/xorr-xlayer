# The Solana mainnet fork behind the fork executor (PLAN.md §11).
#
# Runs solana-test-validator cloning real mainnet accounts:
# - Circle USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# - Jupiter v6 program: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
# - Token-2022 program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
# - xStocks token mints: NVDAx, TSLAx, AAPLx, MSFTx

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl bzip2 ca-certificates libssl-dev jq \
    && rm -rf /var/lib/apt/lists/*

# Install Solana release matching production
ARG SOLANA_VERSION=v1.18.26
RUN sh -c "$(curl -sSfL https://release.solana.com/${SOLANA_VERSION}/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

WORKDIR /app
COPY entrypoint.sh /usr/local/bin/fork-entrypoint
RUN chmod 0755 /usr/local/bin/fork-entrypoint

EXPOSE 8899 8900

ENTRYPOINT ["/usr/local/bin/fork-entrypoint"]
