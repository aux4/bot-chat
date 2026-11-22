# bot chat

## reject an unsigned delivery

```execute
aux4 bot chat verify <<'JSON'
{"method":"POST","rawBody":"{}","headers":{},"bot":{}}
JSON
```

```expect:json
{
  "valid": false,
  "statusCode": 401
}
```

## signed delivery, routing and safe callback retries

```execute
aux4 bot chat test-contract
```

```expect:partial
*fail 0*
```
