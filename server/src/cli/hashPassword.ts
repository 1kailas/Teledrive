import readline from 'node:readline';
import { hashPassword } from '../http/auth.js';

async function promptHidden(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // mute echo while the password is typed
  const rli = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = rli._writeToOutput.bind(rli);
  const answer = new Promise<string>((resolve) => {
    rl.question(query, (a) => resolve(a));
    rli._writeToOutput = () => {};
  });
  try {
    return await answer;
  } finally {
    rli._writeToOutput = orig;
    rl.close();
    process.stdout.write('\n');
  }
}

async function main(): Promise<void> {
  let password = process.argv[2];
  if (!password) password = await promptHidden('Password: ');
  if (password.length < 10) {
    console.error('password must be at least 10 characters');
    process.exit(1);
  }
  console.log(await hashPassword(password));
}

main();
