# Techlink GH contract questions before rollout

**Subject:** Confirm Techlink GH sandbox status vocabulary, callbacks, and test access

Hello Techlink GH support,

FlexiData has implemented a server-only, fail-closed sandbox adapter from the
contract supplied with the official Postman collection. We will not create live
orders, fund an account, or enable production fulfillment while qualifying it.
Please provide any answers and test credentials only through your approved
secure channel; do not send secrets in email or a public ticket.

## Contract facts already supplied

- Base URL: `https://api.techlinkgh.com/api/v1`
- Authentication: server-side `x-api-key`
- Catalogue: `GET /data/bundles?network={network}&phone={phone}` with
  `success`, `provider`, and `bundles[]` fields `id`, `name`, `size`, `price`,
  and `validity`
- Purchase: `POST /data/purchase` with `{ network, phone, bundleId }`; documented
  success is HTTP 201 with `success`, `message`, `orderId`, and `newBalance`
- History: `GET /orders?page=1&limit=25`
- Verification: `POST /orders/:orderId/verify` with `success`, `orderId`,
  `status`, `changed`, and `message`
- Single order: `GET /orders/:id`

The implementation validates these fields, re-fetches the current catalogue before
purchase, uses only an exact returned bundle ID, and keeps an accepted order
pending until authoritative verification. It does not use the generic provider
normalizer or accept callbacks.

## Remaining questions

1. **Sandbox access and authentication**
   - Please provide a sandbox/test key through the secure channel and confirm
     the expected HTTP 401 behavior for an invalid, inactive, or wrong-environment
     key. We will check only key presence in our environment and will not print
     or return its value.
   - Confirm key scope, expiry, IP allow-list, rate limit, and whether the
     documented base URL is also the sandbox host.
2. **Phone and catalogue semantics**
   - Confirm whether `phone` must be a Ghana `233...` MSISDN or may be a local
     `0...` number.
   - Confirm the network identifiers accepted for MTN and Telecel Ghana, the
     price currency/denomination, and whether bundle IDs are stable.
   - Confirm whether `name` is the customer-facing label and whether any
     category field exists. FlexiData will not infer a category or an ID.
3. **Order finality**
   - Please provide the complete `status` vocabulary returned by
     `/orders/:orderId/verify` and `/orders/:id`.
   - Identify which exact status values are terminal delivered, terminal failed,
     pending/queued, or unresolved, and whether `success`/`changed` can conflict
     with `status`.
   - Confirm correlation rules when the order ID is missing, duplicated, delayed,
     or differs between purchase and verification.
   - Confirm duplicate submission, timeout, reversal, and eventual-consistency
     behavior. FlexiData will never blindly retry an ambiguous purchase POST.
4. **Callbacks/webhooks**
   - If callbacks exist, provide the event schema, signed bytes, signature header,
     secret provisioning, timestamp/nonce window, replay protection, and retry
     behavior. Callbacks remain disabled until these rules are documented.
5. **Read-only qualification**
   - Confirm that catalogue reads, order history, single-order lookup, and verify
     calls used against known test orders are safe and do not create or charge an
     order.
   - Provide sandbox limits, supported test networks, reset behavior, and the
     escalation contact for a stuck test order.

Once these details and a sandbox key are verified, FlexiData can add an exact
status classifier and run a read-only catalogue smoke test. We will not run a
live purchase or change production configuration as part of that qualification.

Regards,

FlexiData engineering
