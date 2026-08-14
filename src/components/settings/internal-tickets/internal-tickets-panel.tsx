'use client';

import { useState } from 'react';
import { Building2, CircleDot, Milestone, Tag, UsersRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SettingsPanelHead } from '../settings-panel-head';
import { SimpleCatalogManager } from './simple-catalog-manager';
import { DefaultAwareCatalogManager } from './default-aware-catalog-manager';
import { TeamManager } from './team-manager';

type Tab = 'types' | 'statuses' | 'stages' | 'teams' | 'companies';

/**
 * Settings → Internal Tickets (052-INT-B). Configuration-only for now
 * — types, statuses, stages, teams (+ membership) and companies.
 * internal_tickets itself (the chamados list/detail/CRUD) is a later
 * phase (052-INT-C+), deliberately not built here.
 *
 * Read access is open to every account member (viewer/agent included)
 * — each sub-manager gates its own write controls via
 * useCan('edit-settings'), it does not hide the whole tab. This
 * mirrors the RLS shape in migration 052: SELECT for any member,
 * INSERT/UPDATE for admin/owner only.
 */
export function InternalTicketsPanel() {
  const t = useTranslations('Settings.internalTickets');
  const [tab, setTab] = useState<Tab>('types');

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-2">
        <TabsList>
          <TabsTrigger value="types">
            <Tag className="mr-1.5 size-4" /> {t('tabTypes')}
          </TabsTrigger>
          <TabsTrigger value="statuses">
            <CircleDot className="mr-1.5 size-4" /> {t('tabStatuses')}
          </TabsTrigger>
          <TabsTrigger value="stages">
            <Milestone className="mr-1.5 size-4" /> {t('tabStages')}
          </TabsTrigger>
          <TabsTrigger value="teams">
            <UsersRound className="mr-1.5 size-4" /> {t('tabTeams')}
          </TabsTrigger>
          <TabsTrigger value="companies">
            <Building2 className="mr-1.5 size-4" /> {t('tabCompanies')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="types" className="mt-4">
          <SimpleCatalogManager
            namespace="Settings.internalTicketTypes"
            endpoint="/api/internal-tickets/types"
            listKey="types"
            icon={Tag}
          />
        </TabsContent>

        <TabsContent value="statuses" className="mt-4">
          <DefaultAwareCatalogManager
            namespace="Settings.internalTicketStatuses"
            endpoint="/api/internal-tickets/statuses"
            listKey="statuses"
            hasColor
            icon={CircleDot}
          />
        </TabsContent>

        <TabsContent value="stages" className="mt-4">
          <DefaultAwareCatalogManager
            namespace="Settings.internalTicketStages"
            endpoint="/api/internal-tickets/stages"
            listKey="stages"
            hasColor={false}
            icon={Milestone}
          />
        </TabsContent>

        <TabsContent value="teams" className="mt-4">
          <TeamManager />
        </TabsContent>

        <TabsContent value="companies" className="mt-4">
          <SimpleCatalogManager
            namespace="Settings.internalCompanies"
            endpoint="/api/internal-tickets/companies"
            listKey="companies"
            icon={Building2}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
