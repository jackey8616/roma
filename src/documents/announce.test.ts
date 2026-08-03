import { describe, expect, it } from 'vitest'
import { SESSION_ID_VAR } from '../shim-protocol.js'
import { announceDocuments, CONVERSATION_TAG, DOCUMENT_SHORTCUT } from './announce.js'
import type { Depot } from './depot.js'

/**
 * What every Session with a Document Reach is told, asserted as text.
 *
 * The text is the feature. Everything ADR-0022 §10 buys — the Turns not spent
 * rediscovering how to authenticate, the agent writing the document instead of
 * explaining it cannot, the 403 on a trash reported as the permission model
 * rather than as roma being broken — happens because of what these sentences
 * say, so asserting on them is asserting on the thing rather than on a rendering
 * of it.
 *
 * What it *claims* about Drive is written from Google's documentation and has
 * never been measured — that a Contributor may create and edit and may not move,
 * trash or delete, and that one credential covers both the Docs and the Sheets
 * API on files the app created. ADR-0022's Verification status says the role
 * table is the thing most likely to be wrong, because the whole of "the agent
 * cannot destroy anything" rests on it. These tests hold roma to *saying* it;
 * only a real shared drive can settle whether it is true.
 */

const ACCOUNT = 'writer@a-project.iam.gserviceaccount.com'
const DEPOT: Depot = { id: 'FOLDER_ID', name: 'Team documents' }

describe('telling a Session it can write the team’s documents', () => {
  it('names the command and what it prints', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain(DOCUMENT_SHORTCUT)
    expect(said).toContain('--json')
    expect(said).toContain(`$(${DOCUMENT_SHORTCUT})`)
  })

  // Story 38. An agent that reasons about how much of the hour is left is an
  // agent spending a Turn on arithmetic it never needed to do.
  it('says re-running it is free and stateless, and there is nothing to renew', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/free and stateless/i)
    expect(said).toMatch(/nothing[\s\S]{0,20}renew/i)
  })

  it('names the identity the agent acts as', () => {
    expect(announceDocuments(ACCOUNT, DEPOT)).toContain(ACCOUNT)
  })

  // Story 34: without the id the agent spends a Turn asking which folder, or
  // guessing. The name is beside it so the agent can say where it put something
  // in words a person recognises.
  it('names the Depot, by id and by what it is called', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain('FOLDER_ID')
    expect(said).toContain('Team documents')
  })

  // Story 33 and the whole point of a native file rather than an uploaded one:
  // a Doc and a Sheet are what a PM can comment on, restore, and link to.
  it('says both formats are available, and that they are native files', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/Docs/)
    expect(said).toMatch(/Sheets/)
    expect(said).toMatch(/native/i)
  })

  // Stories 35 and 36, and the second is the one that costs a Turn if it is
  // missing: told only that it may not delete, an agent meeting a 403 goes and
  // investigates roma. Told whose refusal it is, it reports the right thing to
  // the person who asked.
  it('says what it may not do, and that the refusal is Google’s rather than roma’s', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/\bmove\b/)
    expect(said).toMatch(/\btrash\b/)
    expect(said).toMatch(/\bdelete\b/)
    expect(said).toMatch(/Google’s\s*\n?\s*answer rather than roma’s/)
    expect(said).toContain('Contributor')
  })

  // Story 7, and the reason it is here rather than left to the agent's judgement:
  // "cannot delete" is not "cannot lose data" — replacing a file's contents is an
  // edit, which a Contributor may do — so the thing to say is that updating is
  // allowed and that Drive keeps the history either way.
  it('says updating a document it created is allowed, and versioned', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/version history/i)
    expect(said).toMatch(/rather than creating a second one|over\s*\n?\s*creating a second one/i)
  })

  // Story 41 and ADR-0022 §7. The value is forward-looking as much as immediate:
  // an untagged Depot is one where nothing can be attributed to the thread that
  // produced it, and nothing done later reaches backwards.
  it('teaches the tagging convention, with the key and the query', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain('appProperties')
    expect(said).toContain(CONVERSATION_TAG)
    // What roma actually puts in the agent's environment. §7 asks for the
    // Conversation Key, which never reaches a Session — see `announce.ts`, where
    // the substitution and what it costs are argued.
    expect(said).toContain(SESSION_ID_VAR)
    expect(said).toMatch(/appProperties has/)
  })

  // ADR-0022 §10's one sentence of fact, and the asymmetry the agent has no way
  // to guess: every other place roma has ever given it is private.
  it('says the Depot is shared by every Conversation and everyone who can message roma', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/visible to every Conversation/)
    expect(said).toMatch(/everyone who can message roma/)
  })

  // Stated, not instructed. roma cannot know what a deployment considers
  // sensitive, and a guessed policy is worse than none because it reads as a
  // control while controlling nothing.
  it('states that and instructs nothing about it', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).not.toMatch(/sensitive/i)
    expect(said).not.toMatch(/do not put/i)
  })

  // The live cost ADR-0015 accepted for the cloud, in its second colour: told
  // nothing, an agent reaches for a CLI, reports it is missing, and the
  // capability is invisible again.
  it('says there is no CLI, so that the agent writes the API call', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/no Drive CLI/i)
    expect(said).toMatch(/REST API/i)
  })

  // Story 4. Nothing enforces it and roma cannot see whether it happened, which
  // is exactly why it is said here.
  it('asks for the link to go in the answer, since nothing else can carry it', () => {
    expect(announceDocuments(ACCOUNT, DEPOT)).toMatch(/link/i)
  })
})
