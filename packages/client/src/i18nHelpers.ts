import { Status } from './statuses'
import { Transfer, Step } from './types'

export enum StepStatus {
  PENDING = 'pending',
  COMPLETE = 'completed',
  FAILED = 'failed',
}
export const PENDING = StepStatus.PENDING
export const COMPLETE = StepStatus.COMPLETE
export const FAILED = StepStatus.FAILED

export function stepsFor (
  transfer: Transfer,
  steps: string[],
  descriptions: { [key: string]: string }
): Step[] {
  const completed = steps.indexOf(String(transfer.completedStep))
  return steps.map((key, i) => ({
    key,
    description: descriptions[key],
    status: transfer.status === Status.FAILED && i === completed + 1
      ? StepStatus.FAILED
      : i <= completed ? StepStatus.COMPLETE : StepStatus.PENDING
  }))
}
