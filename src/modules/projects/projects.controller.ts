// src/modules/projects/projects.controller.ts
import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ProjectsService } from './projects.service';

@Controller('api/projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) { }

  @Get()
  async findAll(@Request() req) {
    const projects = await this.projectsService.findAll(req.user.id);
    return projects.map(p => ({ ...p, title: p.nome, description: p.descricao }));
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req) {
    const p = await this.projectsService.findOne(req.user.id, id);
    return { ...p, title: p.nome, description: p.descricao };
  }

  @Post()
  async create(@Body() body: any, @Request() req) {
    const mapped = {
      nome: body.nome || body.title || body.name || '',
      descricao: body.descricao || body.description || '',
    };
    const project = await this.projectsService.create(req.user.id, mapped);
    return { ...project, title: project.nome, description: project.descricao };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @Request() req) {
    const mapped: any = {};
    if (body.nome || body.title || body.name) mapped.nome = body.nome || body.title || body.name;
    if (body.descricao || body.description) mapped.descricao = body.descricao || body.description;
    const p = await this.projectsService.update(req.user.id, id, mapped);
    return { ...p, title: p.nome, description: p.descricao };
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req) { return this.projectsService.remove(req.user.id, id); }
}
