import { account } from './account.mjs';
import { checkCredential } from './auth.ts';

const [action, expectedAccount] = process.argv.slice(2);
if (action === 'status') {
  console.log(JSON.stringify({ signedIn: account.hasSavedLogin() }));
} else if (action === 'login') {
  if (!expectedAccount || !expectedAccount.startsWith('8:')) throw new Error('Supply the approved account MRI');
  const session = await account.beginLogin();
  console.log(JSON.stringify({ verificationUrl: session.url, userCode: session.code, expiresAt: session.expiresAt }));
  await account.completeLogin(new AbortController().signal, expectedAccount);
  checkCredential(await account.getSkypeToken(), expectedAccount);
  console.log('Approved Teams account signed in');
} else throw new Error('Usage: node src/account-cli.mjs status | login <approved-account-MRI> (private operator terminal only)');
