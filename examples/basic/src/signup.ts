/** Synthetic source for diagram generation; no service is connected or started. */
export type AccountStatus = 'pending' | 'active' | 'deleted';

export interface Account {
  id: string;
  email: string;
  status: AccountStatus;
}

export interface AccountStore {
  findByEmail(email: string): Promise<Account | null>;
  insert(account: Account): Promise<void>;
}

export interface WelcomeQueue {
  send(message: { accountId: string; email: string }): Promise<void>;
}

export interface SignupDependencies {
  accounts: AccountStore;
  welcome: WelcomeQueue;
  newId(): string;
}

export async function submitSignup(
  input: { email: string },
  dependencies: SignupDependencies,
): Promise<Account> {
  return await registerAccount(input.email, dependencies);
}

export async function registerAccount(
  email: string,
  dependencies: SignupDependencies,
): Promise<Account> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new Error('A valid email address is required');
  }

  const existing = await dependencies.accounts.findByEmail(normalizedEmail);
  if (existing) throw new Error('Account already exists');

  const account: Account = {
    id: dependencies.newId(),
    email: normalizedEmail,
    status: 'pending',
  };
  await dependencies.accounts.insert(account);
  await dependencies.welcome.send({ accountId: account.id, email: account.email });
  return account;
}
