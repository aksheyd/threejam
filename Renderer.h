#ifndef RENDERER_H
#define RENDERER_H

#include <iostream>
#include "Component.h"
#include "shader_s.h"

#include <string>

//enum ShaderDimension {
//	Two = 2,
//	Three = 3
//};

class Renderer : public Component
{
protected:
	Shader _shader;
public:
	// default construct 2D shader
	Renderer() : _shader(Shader("shaders/2dshader.vert", "shaders/2dshader.frag")), Component("Renderer") {}
	Renderer(const std::string& name) : _shader(Shader("shaders/2dshader.vert", "shaders/2dshader.frag")), Component(name) {}

	Shader ChangeShader(std::string& new_vert, std::string& new_frag) {
		Shader newShader(new_vert.c_str(), new_frag.c_str());
		_shader = newShader;
		return newShader;
	}
};

#endif