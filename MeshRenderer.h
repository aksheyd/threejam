#ifndef MESHRENDERER_H
#define MESHRENDERER_H

#include <iostream>
#include "MeshFilter.h"
#include "Renderer.h"
#include <glm/glm.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <string>

class MeshRenderer : public Renderer
{
public:
	glm::vec4 color;

	// pink if color is uninit
	MeshRenderer() : color(1.0f, 0.4f, 0.8f, 1.0f), Renderer("MeshRenderer") {
		_shader.use();
	}

	MeshRenderer(glm::vec4& _color) : color(_color), Renderer("MeshRenderer") {
		_shader.use();
	}

    void Update() {
		// MeshRenderer controls rendering of MeshFiler
        MeshFilter* meshFilter = gameObject->GetComponent<MeshFilter>();

        if (meshFilter == nullptr) {
			return; // no meshFilter to render
        }

		_shader.setVec4("color", color);
		_shader.use();

		//std::cout << meshFilter->mesh.name << std::cout;
		meshFilter->mesh->Draw();
    }

};

#endif