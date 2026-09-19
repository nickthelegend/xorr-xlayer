/**
 * The delegation contract to ask the chain about: the one this build pinned, else the one its executor names.
 *
 * `standingOnChain` answers "none" when it is handed no contract, which is right for a build that knows of none and wrong
 * for a build that simply did not pin one — a development or simulator build. Those read Home's Permit step and Safety
 * as NOT GRANTED over a live grant on chain. The executor's `/delegation/params` names the contract it trades through;
 * a lookup that fails is `unreadable`, so no screen turns "could not ask" into "nothing granted".
 */
import { isAddress, type Address } from 'viem';
import { pinnedDelegation } from '@/chain';
import { system } from '@/data/system';

export async function contractToRead(
  pinned: Address | undefined = pinnedDelegation,
  named: () => Promise<{ contract?: string }> = () => system.delegationParams(),
): Promise<Address | 'unreadable'> {
  if (pinned) return pinned;
  try {
    const { contract } = await named();
    return contract && isAddress(contract) ? contract : 'unreadable';
  } catch {
    return 'unreadable';
  }
}
