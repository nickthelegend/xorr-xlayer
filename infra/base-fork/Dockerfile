# The Base mainnet fork behind the fork executor (PLAN.md 3.3).
#
# Deployed to the Railway service `base-fork`, which has a volume mounted at /data (docs/RUNBOOK.md §8):
#   railway up --project <id> --environment production --service base-fork --ci     # from this directory
#
# Pinned, not `latest`: the saved chain is anvil's own state format, and a restart that pulled a newer anvil
# could refuse the file an older one wrote. This is the anvil the save-and-resume round trip was proven with.
FROM ghcr.io/foundry-rs/foundry:v1.7.1

# The volume mounts owned by root; the image's own user could not write the saved chain to it.
USER root
COPY entrypoint.sh /usr/local/bin/fork-entrypoint
RUN chmod 0755 /usr/local/bin/fork-entrypoint

ENTRYPOINT ["/usr/local/bin/fork-entrypoint"]
