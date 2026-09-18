import 'dotenv/config';
import { parseUnits, type Address } from 'viem';
import { readPolicy, DELEGATION_ABI, DELEGATION_ADDRESS } from './src/evm/delegation.js';
import { publicClient, delegateAccount } from './src/evm/client.js';

const OWNER = '0x95A0b368588713011a15f4b1041423f31B08e615' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const VENUE = '0x111111125421cA6dc452d289314280a0f8842A65' as Address;

const trySpend = async () => {
  try {
    await publicClient.simulateContract({
      account: delegateAccount.address, address: DELEGATION_ADDRESS, abi: DELEGATION_ABI,
      functionName: 'spend', args: [OWNER, USDC, VENUE, parseUnits('1', 6), '0x'],
    });
    return 'WENT THROUGH — the guard did not fire';
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return m.match(/[A-Za-z]+\([^)]*\)/)?.[0] ?? m.split('\n')[0].slice(0, 70);
  }
};

console.log('chain      ', process.env.XORR_CHAIN);
console.log('delegation ', DELEGATION_ADDRESS);
console.log('signing as ', delegateAccount.address);
const p = await readPolicy(OWNER);
console.log('policy     ', p ? `revoked=${p.revoked} cap=$${p.dailyCapUsd} delegate=${p.delegate}` : 'none on chain');
console.log('spend()    ', await trySpend());
