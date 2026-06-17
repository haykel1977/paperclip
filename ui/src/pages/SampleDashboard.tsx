import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  Activity, 
  Users, 
  TrendingUp, 
  Clock, 
  AlertTriangle, 
  CheckCircle,
  Calendar,
  Target,
  DollarSign
} from "lucide-react";

interface Agent {
  id: string;
  name: string;
  status: "active" | "paused" | "error";
  lastActive: string;
  tasksCompleted: number;
}

interface Project {
  id: string;
  name: string;
  progress: number;
  deadline: string;
  members: number;
}

interface Task {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  assignee: string;
  dueDate: string;
}

export function SampleDashboard() {
  const [agents] = useState<Agent[]>([
    { id: "1", name: "Code Assistant", status: "active", lastActive: "2 mins ago", tasksCompleted: 12 },
    { id: "2", name: "Research Bot", status: "active", lastActive: "5 mins ago", tasksCompleted: 8 },
    { id: "3", name: "Marketing Expert", status: "paused", lastActive: "1 hour ago", tasksCompleted: 5 },
    { id: "4", name: "Data Analyst", status: "error", lastActive: "10 mins ago", tasksCompleted: 3 },
  ]);

  const [projects] = useState<Project[]>([
    { id: "1", name: "Product Launch", progress: 75, deadline: "2024-06-15", members: 4 },
    { id: "2", name: "Market Research", progress: 40, deadline: "2024-07-01", members: 3 },
    { id: "3", name: "Documentation", progress: 20, deadline: "2024-06-30", members: 2 },
  ]);

  const [tasks] = useState<Task[]>([
    { id: "1", title: "Write API documentation", priority: "high", assignee: "Code Assistant", dueDate: "2024-06-10" },
    { id: "2", title: "Analyze market trends", priority: "medium", assignee: "Research Bot", dueDate: "2024-06-12" },
    { id: "3", title: "Create marketing materials", priority: "high", assignee: "Marketing Expert", dueDate: "2024-06-14" },
  ]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-green-500";
      case "paused": return "bg-yellow-500";
      case "error": return "bg-red-500";
      default: return "bg-gray-500";
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high": return "bg-red-100 text-red-800";
      case "medium": return "bg-yellow-100 text-yellow-800";
      case "low": return "bg-green-100 text-green-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Overview of your AI agents and projects</p>
        </div>
        <Button variant="default">New Task</Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Agents</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">12</div>
            <p className="text-xs text-muted-foreground">+2 from last month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Projects</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">8</div>
            <p className="text-xs text-muted-foreground">+1 from last week</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Tasks</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">15</div>
            <p className="text-xs text-muted-foreground">3 urgent</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">$2,450</div>
            <p className="text-xs text-muted-foreground">+12% from last month</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Agents */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Active Agents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {agents.map(agent => (
                <div key={agent.id} className="flex items-center justify-between p-3 hover:bg-muted rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${getStatusColor(agent.status)}`}></div>
                    <div>
                      <div className="font-medium">{agent.name}</div>
                      <div className="text-sm text-muted-foreground">Last active: {agent.lastActive}</div>
                    </div>
                  </div>
                  <Badge variant={agent.status === "active" ? "default" : agent.status === "paused" ? "secondary" : "destructive"}>
                    {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Upcoming Tasks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Upcoming Tasks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {tasks.map(task => (
                <div key={task.id} className="p-3 hover:bg-muted rounded-lg">
                  <div className="flex justify-between items-start">
                    <div className="font-medium">{task.title}</div>
                    <Badge className={getPriorityColor(task.priority)}>{task.priority}</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Assigned to: {task.assignee}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Due: {task.dueDate}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Projects Progress */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Project Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {projects.map(project => (
                <div key={project.id}>
                  <div className="flex justify-between mb-2">
                    <span className="font-medium">{project.name}</span>
                    <span className="text-sm text-muted-foreground">{project.progress}%</span>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-2">
                    <div 
                      className="bg-primary h-2 rounded-full" 
                      style={{ width: `${project.progress}%` }}
                    ></div>
                  </div>
                  <div className="flex justify-between mt-2 text-sm text-muted-foreground">
                    <span>Deadline: {project.deadline}</span>
                    <span>{project.members} members</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}