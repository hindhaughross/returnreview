# returnreview

## Booking confirmation classification rules

This repository tracks the booking confirmation classification logic for email threads involving collection bookings.

### Core rule

A booking email should only be marked as `confirmed` when the final message in the thread is an unconditional confirmation of the accepted or booked date.

A date change or proposed reschedule is not `confirmed` simply because the email contains a confirmation-style sentence. The system must consider the full thread and the chronology of messages.

### Thread-aware logic

The classifier should process messages in timestamp order and apply the following rules:

- If a lease company message proposes a different date from the original booking, mark it as `for review`.
- If the message contains conditional language such as:
  - "If this isn’t suitable"
  - "please let us know"
  - "if that works"
  - "can we arrange another date"
  - "is that okay"
  - "would you like"
  then do not auto-confirm.
- If an internal team member explicitly accepts the proposed date, record that accepted date.
- If the lease company later sends an unconditional confirmation matching the accepted date, then the case may be moved to `confirmed`.
- If the thread is ambiguous, contains relative dates such as "next week" or "Thursday", or includes multiple date candidates, default to `for review`.

### Examples

#### Example 1: changed date, no final confirmation

Lease company: "I have booked the collection for Thursday 22nd instead. If this isn’t suitable, let us know."

Expected outcome: `for review`

#### Example 2: changed date, then accepted, then confirmed

Lease company: "Unfortunately 23rd was not available, so I have booked for 22nd instead."

Internal: "That works for us."

Lease company: "We are pleased to confirm the new booking details for 22/10/2026."

Expected outcome: `confirmed`

#### Example 3: original date confirmed

Lease company: "We are pleased to confirm collection for 23/10/2026."

Expected outcome: `confirmed`

#### Example 4: conditional language

Lease company: "If this isn’t suitable, please let us know and we can arrange another date."

Expected outcome: `for review`

### Rule summary

In short:

- Changed date + conditional wording = `for review`
- Changed date + accepted by internal + later unconditional confirmation = `confirmed`
- Exact match to booked date + unconditional confirmation = `confirmed`
- Ambiguous date language = `for review`

### Conservative fallback

If there is any doubt, the system should err on the side of `for review` rather than auto-confirming.
