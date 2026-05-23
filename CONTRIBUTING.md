# Contributing to ai-whisper

Thanks for your interest in contributing. This project is licensed under the
[Apache License 2.0](LICENSE).

## Developer Certificate of Origin (DCO)

Contributions to ai-whisper are accepted under the **Developer Certificate of
Origin**. The DCO is a lightweight way for you to certify that you wrote, or
otherwise have the right to submit, the code you contribute. It is not a CLA and
does not transfer any copyright — you keep the copyright to your contribution,
licensed inbound under Apache-2.0.

By signing off on a commit, you certify the statement below (DCO 1.1):

```
Developer Certificate of Origin
Version 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### How to sign off

Add a `Signed-off-by` line to each commit by using the `-s` flag:

```bash
git commit -s -m "your message"
```

This appends a trailer like:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an email you can be reached at. The name and email must
match your Git author identity.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Please run `pnpm lint`, `pnpm build`, `pnpm test`, and `pnpm typecheck` before
opening a pull request.
