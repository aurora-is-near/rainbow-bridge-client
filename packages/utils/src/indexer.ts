/**
 * Build the SQL query for getting transactions from indexer.
 * https://github.com/near/near-indexer-for-explorer/blob/master/docs/near-indexer-for-explorer-db.png
 * @param params Uses Named Arguments pattern, please pass arguments as object
 * @param params.fromBlock NEAR block timestamp.
 * @param params.toBlock 'latest' | NEAR block timestamp.
 * @param params.predecessorAccountId NEAR account id.
 * @param params.receiverAccountId NEAR account id.
 * @returns The formated SQL query.
 */
export function buildIndexerTxQuery (
  { fromBlock, toBlock, predecessorAccountId, receiverAccountId }: {
    fromBlock: string
    toBlock: string
    predecessorAccountId: string
    receiverAccountId: string
  }
): string {
  const nearAccountFormat = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
  if (!nearAccountFormat.test(predecessorAccountId)) {
    throw new Error(`Invalid predecessor_account_id format: ${predecessorAccountId}`)
  }
  if (!nearAccountFormat.test(receiverAccountId)) {
    throw new Error(`Invalid receiver_account_id format: ${receiverAccountId}`)
  }
  if (!/^[\d]*$/.test(fromBlock)) {
    throw new Error(`Invalid fromBlock format: ${fromBlock}`)
  }
  if (!/^((latest)|[\d]*)$/.test(toBlock)) {
    throw new Error(`Invalid toBlock format: ${toBlock}`)
  }
  return `SELECT public.receipts.originated_from_transaction_hash, public.action_receipt_actions.args
    FROM public.receipts
    JOIN public.action_receipt_actions
    ON public.action_receipt_actions.receipt_id = public.receipts.receipt_id
    WHERE (predecessor_account_id = '${predecessorAccountId}'
      AND receiver_account_id = '${receiverAccountId}'
      AND included_in_block_timestamp > ${fromBlock}
      ${toBlock !== 'latest' ? 'AND included_in_block_timestamp < ' + toBlock : ''}
    )`
}
