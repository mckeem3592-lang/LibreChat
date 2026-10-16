# Mission AI SSH relay topology

This is a configuration template for an existing, user-controlled Linux relay. It does not provision an EC2 instance or VPS. The relay requires a stable DNS name and reachable SSH service; no public listener on port 2222 is needed.

```text
Home Mac sshd :22
  -- Mac-initiated SSH -R 127.0.0.1:2222:127.0.0.1:22 --> relay loopback :2222
Office Windows -- SSH -L 127.0.0.1:2222:127.0.0.1:2222 --> relay SSH :22
Office Windows localhost :2222 -- SSH/SCP with a separate Mac-authorized key --> Home Mac :22
```

Use separate, unprivileged relay accounts `mission-home` and `mission-office`. The existing `initialize-relay-bridge.ps1` expects `MISSION_AI_RELAY_USER=mission-office`. Its office key is `%USERPROFILE%\.ssh\mission_ai_mac_ed25519`; the Mac needs its own relay key. The office key must also be separately authorized by the Mac's SSH account for the final hop. Pin the relay and Mac host keys in the office `known_hosts` after checking their fingerprints through a trusted channel.

## Relay SSH configuration

In a root-owned `/etc/ssh/sshd_config.d/90-mission-ai-relay.conf` on OpenSSH 8.9 or later, apply these rules. Check the effective configuration with `sshd -T`; earlier global directives may take precedence on some installations. `GatewayPorts clientsignals` is not an OpenSSH setting. The supported value is `clientspecified`; the key and `PermitListen` rules still force the reverse listener to loopback.

```sshdconfig
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowUsers mission-home mission-office
GatewayPorts clientspecified
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
MaxAuthTries 3
LogLevel VERBOSE

Match User mission-home
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:2222
    MaxSessions 0

Match User mission-office
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:2222
    MaxSessions 0
```

`MaxSessions 0` permits forwarding while disabling interactive shell/subsystem sessions. Ensure there is no conflicting `DisableForwarding yes` directive. Validate before reloading:

```sh
sudo sshd -t
sudo sshd -T -C user=mission-home,host=localhost,addr=127.0.0.1 | grep -E 'gatewayports|allowtcpforwarding|permitlisten|maxsessions'
sudo sshd -T -C user=mission-office,host=localhost,addr=127.0.0.1 | grep -E 'allowtcpforwarding|permitopen|maxsessions'
sudo systemctl reload sshd  # use ssh on distributions naming the service ssh
```

Create each account without sudo rights, keep its home directory owned by that account, and set `~/.ssh` to mode 700 and `authorized_keys` to mode 600. Add the **office** key output of `stage-authorized-keys.ps1` only to `mission-office`'s `authorized_keys`. Add the distinct **Mac** public key to `mission-home`'s `authorized_keys` with this prefix:

```text
restrict,port-forwarding,permitlisten="127.0.0.1:2222" ssh-ed25519 <MAC_PUBLIC_KEY_BASE64> mission-ai-home
```

Never place either private key on the relay. The office helper emits a single public-key line with `restrict,port-forwarding,permitopen="127.0.0.1:2222"` and no private material. Keep the accounts' key files separate.

## Network and endpoint checks

Allow relay inbound TCP 22 only from the current office and home source IP ranges in the cloud security group and host firewall; permit the corresponding outbound and established flows. Do **not** open inbound TCP 2222 in AWS, the VPS firewall, or `sshd`: that listener must be `127.0.0.1:2222` on the relay. If source IPs change, update the allowlist through the provider console before retrying. The Mac and office initiate outbound SSH to relay port 22.

Mac initiation (using its own key and a pinned relay host key):

```sh
ssh -N -T -i ~/.ssh/mission_ai_relay_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:2222:127.0.0.1:22 mission-home@RELAY_HOST
```

On the relay, `ss -lnt | grep '127.0.0.1:2222'` should show only a loopback listener after the Mac connects. The office utility then creates its own loopback `-L` forward and verifies the Mac hop. A closed public relay port 2222 is expected; a missing loopback listener means the Mac has not connected.

References: [OpenSSH sshd_config](https://man.openbsd.org/sshd_config.5), [OpenSSH authorized_keys options](https://man.openbsd.org/sshd.8), [AWS security group guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/changing-security-group.html).
