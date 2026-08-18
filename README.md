# Sciilo Codex Sidecar

The sidecar connects a project on your computer to Sciilo. It runs Codex
locally in the folder you choose and adds the Sciilo tools needed to create or
update documents, notes, and diagrams.

Codex is installed automatically with the sidecar. You do not need to download
or install the Codex CLI, the Codex desktop application, or Visual Studio Code
separately.

Your project code remains in your local Codex workspace. Sciilo receives only
the folder name and a fingerprint used to recognize the project; the absolute
folder path is never sent.

## How Sciilo protects document contents

Sciilo encrypts document contents before they are stored. Markdown bodies,
diagram sources, notes, and generated document excerpts are sealed with
authenticated AES-256-GCM encryption. The Sciilo backend stores ciphertext and
never receives the document data key in readable form, so it cannot open these
protected fields.

Codex still needs to read and update documents to be useful. When the sidecar
starts, it creates an ephemeral ECDH P-256 key pair. Its private key is
non-extractable, remains in process memory, and disappears when the sidecar
stops. The browser seals the document data key for that running sidecar's
public key; Sciilo only relays the sealed parcel. A parcel captured from an
earlier run cannot be opened by a later sidecar process.

Once unlocked, the sidecar decrypts protected fields in memory for the local
Codex runtime and encrypts content-bearing tool calls before they reach the
backend. Each encrypted value is bound to its document and field. Altering it,
or moving it to a different document or field, makes decryption fail instead
of returning plausible but modified content.

This protection has deliberate boundaries:

- the running sidecar and local Codex process can read plaintext, because they
  need it to work on the documents;
- document titles, dates, identifiers, links, and other library metadata remain
  readable so Sciilo can organize the library without opening the vault;
- document encryption does not cover project files in the local workspace or
  arbitrary text shared in prompts and assistant conversations;
- the document key is not kept in the sidecar configuration file; access is
  restored through the Sciilo vault, using the account password or the recovery
  key shown by Sciilo;
- losing both the password and the recovery key can make encrypted contents
  unrecoverable: there is no server-side back door.

## Before you begin

You need:

- a Sciilo account and a connection key generated in Sciilo;
- Node.js 22 or later;
- either a ChatGPT account with access to Codex or an OpenAI API key.

If you already use Codex on this computer, the sidecar can reuse its local
session. The existing Codex installation itself is optional.

## Guided installation

You can copy and paste the commands below into a terminal.

### 1. Install Node.js

Download the LTS version from [nodejs.org](https://nodejs.org/), install it,
then close and reopen your terminal.

Check the installation:

```shell
node --version
npm --version
```

The first command must display `v22` or a higher version number.

### 2. Download and install the sidecar

From this repository's GitHub page:

1. click **Code**, then **Download ZIP**;
2. extract the downloaded archive;
3. open a terminal in the extracted folder;
4. run:

```shell
chmod +x install.sh
./install.sh
```

The installation automatically downloads the Codex version selected for the
sidecar and the binary matching your computer. Codex remains a private
dependency: no global `codex` command is required.

You may move or delete the downloaded folder after installation without
breaking the installed command.

Check that the sidecar is available:

```shell
sciilo-sidecar --help
```

> On Windows, use
> [WSL](https://learn.microsoft.com/windows/wsl/install), because the
> installation script uses Bash.

### 3. Generate the Sciilo connection key

1. open Sciilo and sign in;
2. open the Codex assistant page;
3. click **Connect**, then **Generate a key**;
4. copy the key immediately: it is displayed only once.

This key starts with `sc_`. It connects this sidecar to your Sciilo account; it
is not an OpenAI key.

### 4. Configure the sidecar and Codex

You can authenticate Codex with a ChatGPT account, an existing local Codex
session, or an OpenAI API key.

#### Option A — ChatGPT account or existing Codex session

Run:

```shell
sciilo-sidecar setup
```

The program asks for:

- **Application URL**: the HTTPS address of your Sciilo application;
- **Connection key**: the key copied from Sciilo;
- **Codex provider**: press Enter to use the Codex configuration;
- **Model**: press Enter to keep `gpt-5.6-sol`, or enter another model available
  to your account.

After these questions, the sidecar checks Codex authentication:

- if a Codex session already exists on the computer, it is reused;
- otherwise, a ChatGPT sign-in page opens in your browser.

The sidecar does not copy credentials from an existing installation. Its
private Codex runtime and other Codex installations simply use the same local
credential storage managed by Codex.

#### Option B — OpenAI API key

This option uses your OpenAI Platform organization's usage-based billing.
Create a key on the [API keys](https://platform.openai.com/api-keys) page and
make sure its project can use the `gpt-5.6-sol` model.

An API key is not dedicated to a single model: it identifies an OpenAI project.
Model access and billing depend on that project.

To keep the key out of your terminal history, enter it silently:

```shell
read -s -p "OpenAI API key: " SCIILO_CODEX_API_KEY
echo
export SCIILO_CODEX_API_KEY
sciilo-sidecar setup
unset SCIILO_CODEX_API_KEY
```

The sidecar temporarily passes the key to Codex credential storage and does
not keep a copy in its own configuration.

If a ChatGPT or Codex session is already active, it is reused first. To
deliberately change accounts or authentication methods, sign out through the
Codex installation that currently manages that session, then run the setup
again.

ChatGPT sign-in uses the permissions of your subscription or workspace. An API
key uses your OpenAI Platform organization's usage-based billing. See the
[official Codex authentication documentation](https://learn.chatgpt.com/docs/codex/auth)
for details.

The sidecar configuration is stored in
`~/.config/sciilo-sidecar/config.json`, with permissions restricted to your
user account. One configuration works for every project on the computer.

### 5. Start the sidecar in a project

Open a terminal in the project folder:

```shell
cd /path/to/my-project
sciilo-sidecar
```

The current folder becomes the Codex workspace and selects the corresponding
project in Sciilo. Keep this terminal open while using the sidecar. Press
`Ctrl+C` to stop it.

To select a folder without changing directories:

```shell
sciilo-sidecar --workspace /path/to/my-project
```

## Everyday use

Display the configuration and Codex sign-in status:

```shell
sciilo-sidecar status
```

Open another project:

```shell
cd /path/to/another-project
sciilo-sidecar
```

Only one sidecar may use a connection key at a time. If two processes connect
with the same key, Sciilo revokes it to prevent them from continuously
replacing each other.

## Updating

Download and extract the new repository version, then run:

```shell
./install.sh
```

The sidecar and its private Codex runtime are replaced together. Your Sciilo
configuration and local Codex session are preserved.

## Uninstalling

Remove the sidecar and its private Codex runtime:

```shell
npm uninstall --global @sciilo.ai/codex-sidecar
```

This command does not remove the configuration stored in
`~/.config/sciilo-sidecar/` or the local session managed by Codex.

## Security and privacy

- Never share your Sciilo connection key or OpenAI API key.
- No OpenAI key is embedded in the distributed package.
- The sidecar configuration file is created with permissions restricted to
  your user account (`0600`).
- A remote Sciilo connection must use HTTPS. HTTP is accepted only for
  `localhost`.
- The absolute workspace path remains on your computer. The sidecar sends only
  the folder name and a stable SHA-256 fingerprint.
- Codex asks for the required approvals before protected operations, according
  to your Codex configuration.
- The Codex runtime is pinned to a version tested with the sidecar and changes
  only when you update the sidecar.

## Troubleshooting

### `node: command not found` or a version below 22

Install the current LTS version from [nodejs.org](https://nodejs.org/), reopen
the terminal, and run `node --version` again.

### `sciilo-sidecar: command not found`

Run `./install.sh` again. At the end, the installer displays either the command
path or the line you need to add to your `PATH`.

### A global `codex` command cannot be found

This is expected: the Codex runtime supplied with the sidecar is private and
does not need to be in your `PATH`. Use:

```shell
sciilo-sidecar status
```

### The Codex runtime is missing or damaged

Download the repository again and run:

```shell
./install.sh
```

The installer automatically downloads the Codex package for your platform.

### Permission error during installation

Do not use `sudo`. Install Node.js for your user account, reopen the terminal,
and run `./install.sh` again.

### Codex is not authenticated

Run:

```shell
sciilo-sidecar setup
```

To use an API key, repeat the commands from option B without writing the key
directly on the command line.

### The Sciilo key is rejected or revoked

Stop every sidecar with `Ctrl+C`, generate a new key in Sciilo, then run:

```shell
sciilo-sidecar setup
```

### The sidecar does not connect

Check:

```shell
node --version
sciilo-sidecar status
```

Also make sure the Sciilo address starts with `https://`, except for a local
installation on `localhost`.

## License

Sciilo Codex Sidecar is licensed under the
[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution
information.
