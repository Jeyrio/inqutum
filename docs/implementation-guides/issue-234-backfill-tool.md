# Issue #234: Create Operator-Safe Backfill Tool with Dry-Run Diff and Resumable Checkpoints

## Problem Statement

Operators need to backfill data when:
- Adding new derived fields to existing records
- Fixing historical data inconsistencies
- Migrating data formats
- Recomputing aggregates after bug fixes

**Current gap**: No safe tooling for large-scale data backfills with:
- Dry-run preview before actual changes
- Resumable checkpoints for long-running operations
- Clear reporting of successes/failures
- Rollback capability

## Solution Overview

Create a CLI tool that:
1. Previews all changes before execution (dry-run mode)
2. Stores checkpoints for resumability
3. Reports skipped/failed records clearly
4. Provides rollback procedures

## Tool Architecture

**File**: `backend/src/scripts/backfill.ts`

```typescript
import { Command } from 'commander';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';

interface BackfillCheckpoint {
  operation: string;
  lastProcessedId: string;
  processedCount: number;
  skippedCount: number;
  failedCount: number;
  startedAt: string;
  resumedAt?: string;
}

interface BackfillRecord {
  id: string;
  before: any;
  after: any;
  action: 'update' | 'skip' | 'error';
  reason?: string;
}

export class BackfillTool {
  private prisma: PrismaClient;
  private checkpointFile: string;
  private checkpoint: BackfillCheckpoint | null = null;
  private dryRun: boolean;

  constructor(operation: string, dryRun: boolean = true) {
    this.prisma = new PrismaClient();
    this.checkpointFile = `.backfill-${operation}.json`;
    this.dryRun = dryRun;
    
    // Load existing checkpoint if resuming
    if (existsSync(this.checkpointFile)) {
      this.checkpoint = JSON.parse(readFileSync(this.checkpointFile, 'utf8'));
      console.log(`Resuming from checkpoint: ${this.checkpoint!.lastProcessedId}`);
    } else {
      this.checkpoint = {
        operation,
        lastProcessedId: '',
        processedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        startedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Preview changes without applying them
   */
  async preview(
    query: () => Promise<any[]>,
    transform: (record: any) => any
  ): Promise<BackfillRecord[]> {
    const records = await query();
    const changes: BackfillRecord[] = [];

    for (const record of records) {
      try {
        const transformed = transform(record);
        const hasChanges = this.detectChanges(record, transformed);

        if (!hasChanges) {
          changes.push({
            id: record.id,
            before: record,
            after: transformed,
            action: 'skip',
            reason: 'No changes detected',
          });
        } else {
          changes.push({
            id: record.id,
            before: record,
            after: transformed,
            action: 'update',
          });
        }
      } catch (error) {
        changes.push({
          id: record.id,
          before: record,
          after: null,
          action: 'error',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return changes;
  }

  /**
   * Execute backfill with checkpointing
   */
  async execute(
    query: () => Promise<any[]>,
    transform: (record: any) => any,
    update: (id: string, data: any) => Promise<void>
  ): Promise<void> {
    console.log(`Starting backfill (${this.dryRun ? 'DRY RUN' : 'LIVE'})`);
    
    const records = await query();
    console.log(`Found ${records.length} records to process`);

    for (const record of records) {
      // Skip if already processed (resume from checkpoint)
      if (this.checkpoint!.lastProcessedId && 
          record.id <= this.checkpoint!.lastProcessedId) {
        continue;
      }

      try {
        const transformed = transform(record);
        const hasChanges = this.detectChanges(record, transformed);

        if (!hasChanges) {
          this.checkpoint!.skippedCount++;
          console.log(`Skipped ${record.id}: No changes`);
        } else {
          if (!this.dryRun) {
            await update(record.id, transformed);
          }
          this.checkpoint!.processedCount++;
          console.log(`Updated ${record.id}`);
        }
      } catch (error) {
        this.checkpoint!.failedCount++;
        console.error(`Failed ${record.id}:`, error);
      }

      // Update checkpoint
      this.checkpoint!.lastProcessedId = record.id;
      this.saveCheckpoint();
    }

    this.printSummary();
  }

  private detectChanges(before: any, after: any): boolean {
    const beforeHash = createHash('sha256').update(JSON.stringify(before)).digest('hex');
    const afterHash = createHash('sha256').update(JSON.stringify(after)).digest('hex');
    return beforeHash !== afterHash;
  }

  private saveCheckpoint(): void {
    writeFileSync(this.checkpointFile, JSON.stringify(this.checkpoint, null, 2));
  }

  private printSummary(): void {
    console.log('\\n=== Backfill Summary ===');
    console.log(`Processed: ${this.checkpoint!.processedCount}`);
    console.log(`Skipped: ${this.checkpoint!.skippedCount}`);
    console.log(`Failed: ${this.checkpoint!.failedCount}`);
    console.log(`Total: ${this.checkpoint!.processedCount + this.checkpoint!.skippedCount + this.checkpoint!.failedCount}`);
    
    if (this.dryRun) {
      console.log('\\n(DRY RUN - no changes were made)');
      console.log('Run with --apply to execute changes');
    }
  }

  /**
   * Generate diff report
   */
  async generateDiff(changes: BackfillRecord[]): Promise<string> {
    let report = `Backfill Diff Report\\n`;
    report += `Generated: ${new Date().toISOString()}\\n`;
    report += `Total Records: ${changes.length}\\n\\n`;

    const updates = changes.filter(c => c.action === 'update');
    const skips = changes.filter(c => c.action === 'skip');
    const errors = changes.filter(c => c.action === 'error');

    report += `Updates: ${updates.length}\\n`;
    report += `Skips: ${skips.length}\\n`;
    report += `Errors: ${errors.length}\\n\\n`;

    report += `=== Updates ===\\n`;
    for (const change of updates.slice(0, 10)) {  // Show first 10
      report += `\\n[${change.id}]\\n`;
      report += `Before: ${JSON.stringify(change.before, null, 2)}\\n`;
      report += `After: ${JSON.stringify(change.after, null, 2)}\\n`;
    }

    if (updates.length > 10) {
      report += `\\n... and ${updates.length - 10} more updates\\n`;
    }

    report += `\\n=== Errors ===\\n`;
    for (const change of errors) {
      report += `[${change.id}] ${change.reason}\\n`;
    }

    return report;
  }
}

// CLI Interface
const program = new Command();

program
  .name('backfill')
  .description('Operator-safe backfill tool with dry-run and checkpoints')
  .version('1.0.0');

program
  .command('preview <operation>')
  .description('Preview changes without applying them')
  .action(async (operation) => {
    const tool = new BackfillTool(operation, true);
    
    // Example: Backfill invoice statuses
    const changes = await tool.preview(
      async () => {
        return prisma.invoice.findMany({
          where: { status: null }, // Find records needing backfill
        });
      },
      (invoice) => {
        // Transform logic
        return {
          ...invoice,
          status: deriveStatus(invoice),
        };
      }
    );

    const diff = await tool.generateDiff(changes);
    console.log(diff);
  });

program
  .command('execute <operation>')
  .description('Execute backfill with checkpointing')
  .option('--apply', 'Apply changes (default is dry-run)')
  .action(async (operation, options) => {
    const tool = new BackfillTool(operation, !options.apply);
    
    await tool.execute(
      async () => {
        return prisma.invoice.findMany({
          where: { status: null },
        });
      },
      (invoice) => {
        return {
          ...invoice,
          status: deriveStatus(invoice),
        };
      },
      async (id, data) => {
        await prisma.invoice.update({
          where: { id },
          data,
        });
      }
    );
  });

program
  .command('resume <operation>')
  .description('Resume interrupted backfill from checkpoint')
  .option('--apply', 'Apply changes (default is dry-run)')
  .action(async (operation, options) => {
    // Same as execute, checkpoint loaded automatically
    const tool = new BackfillTool(operation, !options.apply);
    // ... continue from checkpoint
  });

program.parse();
```

## Usage Examples

```bash
# Preview changes (no writes)
npm run backfill preview invoice-status

# Execute dry-run (no writes, creates checkpoint)
npm run backfill execute invoice-status

# Execute live (writes data)
npm run backfill execute invoice-status --apply

# Resume after interruption
npm run backfill resume invoice-status --apply
```

## Rollback Procedures

**File**: `docs/BACKFILL_ROLLBACK.md`

```markdown
## Rolling Back a Backfill

### Step 1: Stop Execution
```bash
# Kill running backfill process
pkill -f "backfill execute"
```

### Step 2: Identify Affected Records
```bash
# Load checkpoint to see what was processed
cat .backfill-invoice-status.json
```

### Step 3: Restore from Backup
```sql
-- Restore affected records from pre-backfill backup
BEGIN;

UPDATE invoices i
SET status = b.status
FROM invoices_backup_20240101 b
WHERE i.id = b.id
  AND i.id <= 'last_processed_id_from_checkpoint';

COMMIT;
```

### Step 4: Verify Restoration
```sql
-- Count restored records
SELECT COUNT(*) FROM invoices 
WHERE id <= 'last_processed_id_from_checkpoint';
```

### Step 5: Clean Up
```bash
# Remove checkpoint file
rm .backfill-invoice-status.json
```
```

## Acceptance Criteria Checklist

- [ ] CLI with preview command (dry-run diff)
- [ ] Checkpoint storage for resumability
- [ ] Reports skipped records clearly
- [ ] Reports failed records with errors
- [ ] Automated tests for tool
- [ ] Documentation of failure modes
- [ ] Rollback procedures documented
- [ ] Compatible with existing schemas

## Testing

```typescript
describe('BackfillTool', () => {
  it('previews changes without writing', async () => {
    const tool = new BackfillTool('test', true);
    const changes = await tool.preview(
      async () => [{ id: '1', status: null }],
      (r) => ({ ...r, status: 'active' })
    );
    
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('update');
  });

  it('skips records with no changes', async () => {
    const tool = new BackfillTool('test', true);
    const changes = await tool.preview(
      async () => [{ id: '1', status: 'active' }],
      (r) => r  // No transformation
    );
    
    expect(changes[0].action).toBe('skip');
  });

  it('resumes from checkpoint', async () => {
    // Create checkpoint
    writeFileSync('.backfill-test.json', JSON.stringify({
      operation: 'test',
      lastProcessedId: '5',
      processedCount: 5,
      skippedCount: 0,
      failedCount: 0,
      startedAt: new Date().toISOString(),
    }));

    const tool = new BackfillTool('test', true);
    // Should skip records 1-5, process 6+
  });
});
```
