import { describe, expect, it } from 'vitest'
import { sources } from '../../../test/support/sources.js'

describe('roma provisions nothing', () => {
  it('has no code that could create a Pub/Sub resource, write a grant, or run the Terraform', () => {
    const offenders = sources().filter(({ source }) =>
      PROVISIONING.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

const PROVISIONING = [
  /\bcreateTopic\b/,
  /\bcreateSubscription\b/,
  /\bcreateSchema\b/,
  /\bcreateSnapshot\b/,
  /(?<!\bObject)\.create\s*\(/,
  /\bsetIamPolicy\b/,
  /\bsetPolicy\b/,
  /\bterraform\s+(init|plan|apply|destroy)\b/i,
  /['"`]terraform['"`\s]/i,
]
