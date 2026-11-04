import { HeartPulse } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HealthEventsPanel } from "@/pages/health-events";
import { CancelOutcomesPanel } from "@/pages/cancel-outcomes";

export default function HealthOutcomes() {
  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center gap-3">
        <HeartPulse className="w-5 h-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Health &amp; Outcomes</h2>
          <p className="text-xs text-muted-foreground">
            События сопровождения и исходы отмен — разделены по внутренним
            вкладкам
          </p>
        </div>
      </div>

      <Tabs defaultValue="health-events" className="space-y-4">
        <TabsList className="w-full sm:w-auto justify-start overflow-x-auto">
          <TabsTrigger value="health-events">Health Events</TabsTrigger>
          <TabsTrigger value="cancel-outcomes">Cancel Outcomes</TabsTrigger>
        </TabsList>

        <TabsContent value="health-events">
          <HealthEventsPanel showHeader={false} />
        </TabsContent>
        <TabsContent value="cancel-outcomes">
          <CancelOutcomesPanel showHeader={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
