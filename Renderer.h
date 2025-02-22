#ifndef RENDERER_H
#define RENDERER_H

#include <iostream>
#include "Component.h"
#include "shader_s.h"

#include <string>

class Renderer : public Component
{
	Shader _shader = Shader("shaders/2dshader.vert", "shaders/2dshader.frag");
public:
	Renderer() : Component("Renderer") {}

	Shader ChangeShader(std::string& new_vert, std::string& new_frag) {
		Shader newShader("new_vert", "new_frag");
			_shader = newShader;
			return newShader;
		}
};

#endif