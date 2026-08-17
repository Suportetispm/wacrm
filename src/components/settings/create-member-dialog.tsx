'use client';

// ============================================================
// CreateMemberDialog
//
// "+ Criar usuário" — creates a login directly inside the caller's
// own account (name, e-mail, password, role, queues), no invite
// link involved. A distinct, dedicated dialog from InviteMemberDialog
// — the two flows stay side by side, never merged into one modal:
// invite is async (share a link, the recipient signs up/in later),
// this is synchronous (the admin already knows the person's e-mail
// and sets an initial password on the spot).
//
// Role choices mirror the invite dialog (admin/agent/viewer) — never
// 'owner', which only changes via the ownership-transfer flow.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';

type CreatableRole = 'admin' | 'agent' | 'viewer';

interface QueueOption {
  id: string;
  name: string;
  color: string;
}

interface CreateMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the roster. */
  onCreated: () => void;
}

const MIN_PASSWORD_LENGTH = 8;

export function CreateMemberDialog({ open, onOpenChange, onCreated }: CreateMemberDialogProps) {
  const t = useTranslations('Settings.createMember');
  const tRoles = useTranslations('Settings.roles');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<CreatableRole>('agent');
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setFullName('');
    setEmail('');
    setPassword('');
    setRole('agent');
    setQueueIds([]);
    setSubmitting(false);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQueuesLoading(true);
    // RLS-scoped to the caller's own account — no account id to pass.
    fetch('/api/queues', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setQueues((d.queues as QueueOption[]) ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setQueuesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function toggleQueue(queueId: string, checked: boolean) {
    setQueueIds((prev) => (checked ? [...prev, queueId] : prev.filter((id) => id !== queueId)));
  }

  const valid =
    fullName.trim().length > 0 && email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          email: email.trim(),
          password,
          role,
          queue_ids: queueIds,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const message =
          res.status === 409
            ? t('errorEmailExists')
            : res.status === 403
              ? t('errorForbidden')
              : typeof body?.error === 'string'
                ? body.error
                : t('errorGeneric');
        toast.error(t('toastCreateFailed', { message }));
        return;
      }

      toast.success(t('toastCreated'));
      // Never let the password linger in state past a successful
      // create, even momentarily — reset before closing.
      reset();
      onOpenChange(false);
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('dialogTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="member-create-name" className="text-muted-foreground">
              {t('fieldFullName')}
            </Label>
            <Input
              id="member-create-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={120}
              disabled={submitting}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="member-create-email" className="text-muted-foreground">
              {t('fieldEmail')}
            </Label>
            <Input
              id="member-create-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="member-create-password" className="text-muted-foreground">
              {t('fieldPassword')}
            </Label>
            <Input
              id="member-create-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="bg-muted border-border text-foreground"
            />
            <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('fieldRole')}</Label>
            <Select value={role} onValueChange={(v) => v && setRole(v as CreatableRole)}>
              <SelectTrigger className="w-full bg-muted border-border text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{tRoles('admin')}</SelectItem>
                <SelectItem value="agent">{tRoles('agent')}</SelectItem>
                <SelectItem value="viewer">{tRoles('viewer')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {tRoles(`${role}Hint` as 'adminHint' | 'agentHint' | 'viewerHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('fieldQueues')}</Label>
            {queuesLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('loading')}
              </div>
            ) : queues.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('queuesEmpty')}</p>
            ) : (
              <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                {queues.map((q) => (
                  <label key={q.id} className="flex items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={queueIds.includes(q.id)}
                      onCheckedChange={(checked) => toggleQueue(q.id, checked === true)}
                    />
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: q.color }} />
                      {q.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {!queuesLoading && queues.length > 0 && queueIds.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('queuesNone')}</p>
            )}
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={!valid || submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('createSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
