import { describe, expect, it } from 'vitest'
import { SESSION_ID_VAR } from '../shim-protocol.js'
import { announceDocuments, CONVERSATION_TAG, DOCUMENT_SHORTCUT } from './announce.js'
import type { Depot } from './depot.js'

const ACCOUNT = 'writer@a-project.iam.gserviceaccount.com'
const DEPOT: Depot = { id: 'FOLDER_ID', name: 'Team documents' }

describe('telling a Session it can write the team’s documents', () => {
  it('names the command and what it prints', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain(DOCUMENT_SHORTCUT)
    expect(said).toContain('--json')
    expect(said).toContain(`$(${DOCUMENT_SHORTCUT})`)
  })

  it('says re-running it is free and stateless, and there is nothing to renew', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/free and stateless/i)
    expect(said).toMatch(/nothing[\s\S]{0,20}renew/i)
  })

  it('names the identity the agent acts as', () => {
    expect(announceDocuments(ACCOUNT, DEPOT)).toContain(ACCOUNT)
  })

  it('names the Depot, by id and by what it is called', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain('FOLDER_ID')
    expect(said).toContain('Team documents')
  })

  it('says both formats are available, and that they are native files', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/Docs/)
    expect(said).toMatch(/Sheets/)
    expect(said).toMatch(/native/i)
  })

  it('says what it may not do, and that the refusal is Google’s rather than roma’s', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/\bmove\b/)
    expect(said).toMatch(/\btrash\b/)
    expect(said).toMatch(/\bdelete\b/)
    expect(said).toMatch(/Google’s\s*\n?\s*answer rather than roma’s/)
    expect(said).toContain('Contributor')
  })

  it('says updating a document it created is allowed, and versioned', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/version history/i)
    expect(said).toMatch(/rather than creating a second one|over\s*\n?\s*creating a second one/i)
  })

  it('teaches the tagging convention, with the key and the query', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toContain('appProperties')
    expect(said).toContain(CONVERSATION_TAG)
    expect(said).toContain(SESSION_ID_VAR)
    expect(said).toMatch(/appProperties has/)
  })

  it('says the Depot is shared by every Conversation and everyone who can message roma', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/visible to every Conversation/)
    expect(said).toMatch(/everyone who can message roma/)
  })

  it('states that and instructs nothing about it', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).not.toMatch(/sensitive/i)
    expect(said).not.toMatch(/do not put/i)
  })

  it('says there is no CLI, so that the agent writes the API call', () => {
    const said = announceDocuments(ACCOUNT, DEPOT)

    expect(said).toMatch(/no Drive CLI/i)
    expect(said).toMatch(/REST API/i)
  })

  it('asks for the link to go in the answer, since nothing else can carry it', () => {
    expect(announceDocuments(ACCOUNT, DEPOT)).toMatch(/link/i)
  })
})
