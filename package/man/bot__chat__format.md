#### Description

Validate the structured agent response and require matching conversation and message identifiers.
For a completed turn, forward only artifacts attached to the assistant history
message with an exact matching `replyTo`; at most 8 artifacts and 128 KiB are
accepted. Failed turns become a bounded generic retry message.

#### Usage

```sh
aux4 bot chat format < request.json
```

This is an internal provider command. Configure the connection on the server; credentials are never browser parameters.
